import { buildCfFunction } from './process/setup.js';

import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib/core';
import { Duration } from 'aws-cdk-lib/core';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

interface BackendStackProps extends cdk.StackProps {
  /** BFF セッション暗号化鍵 (SSM SecureString パラメータ名; 未指定時は自動作成) */
  readonly sessionSecretParamName?: string;
  /** CloudFront のカスタムドメイン (指定時は出力のみ。Route53/ACM は別途設定) */
  readonly cloudFrontDomainName?: string;
}

export class BackendStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: BackendStackProps) {
    super(scope, id, props);

    const putParameter = (id: string, name: string, value: string): void => {
      new ssm.StringParameter(this, id, {
        parameterName: name,
        stringValue: value,
      });
    };

    const s3bucket = new s3.Bucket(this, 'S3Bucket', {
      bucketName: 'full-stack-html-app-example-assets',
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
    });

    buildCfFunction();

    const oac = new cloudfront.S3OriginAccessControl(this, 'S3OAC', {
      originAccessControlName: 'OAC for S3 (full-stack-html-app-example-api)',
      signing: cloudfront.Signing.SIGV4_NO_OVERRIDE,
    });

    const functionAssociations = [
      {
        eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
        function: new cloudfront.Function(this, 'WebsiteIndexPageForwardFunction', {
          functionName: 'full-stack-html-app-example-index-forward',
          code: cloudfront.FunctionCode.fromFile({
            filePath: 'function/index.js',
          }),
          runtime: cloudfront.FunctionRuntime.JS_2_0,
        }),
      },
    ];

    const distribution = new cloudfront.Distribution(this, 'CognitoBffDistribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(s3bucket, {
          originId: 's3',
          originAccessLevels: [cloudfront.AccessLevel.READ],
          originAccessControl: oac,
        }),
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
        functionAssociations,
      },
      comment: `${this.stackName} - Cognito BFF distribution (Lambda Function URL)`,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      enabled: true,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
    });

    if (props.cloudFrontDomainName) {
      new cdk.CfnOutput(this, 'CustomDomainNote', {
        value: props.cloudFrontDomainName,
        description: 'CloudFront カスタムドメイン (Route53/ACM は別途設定してください)',
      });
    }

    // ---------- セッション暗号化鍵 (SSM SecureString) ----------
    const sessionSecretParamName =
      props.sessionSecretParamName ?? this.node.tryGetContext('sessionSecretParamName');
    const sessionSecretParam = sessionSecretParamName
      ? ssm.StringParameter.fromStringParameterName(
          this,
          'SessionSecretParamImported',
          sessionSecretParamName,
        )
      : new ssm.StringParameter(this, 'SessionSecretParam', {
          parameterName: `/${this.stackName}/bff-session-secret`,
          description: 'BFF session encryption/signing secret',
          stringValue: 'placeholder',
        });

    // ---------- Amazon Cognito ユーザープール ----------
    const domainPrefix = `${`${this.stackName}-domain`
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .substring(0, 30)}`;
    const cognitoDomainName = `${domainPrefix}.auth.${this.region}.amazoncognito.com`;

    const userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `${this.stackName}-user-pool`,

      featurePlan: cognito.FeaturePlan.ESSENTIALS,

      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
      },

      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },

      passkeyUserVerification: cognito.PasskeyUserVerification.PREFERRED,

      mfa: cognito.Mfa.OFF,
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      selfSignUpEnabled: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ---------- Cognito ユーザープールドメイン (ホスト型UI) ----------
    const userPoolDomain = userPool.addDomain('UserPoolDomain', {
      cognitoDomain: { domainPrefix },
    });

    const setPasskey = new cr.AwsCustomResource(this, 'SetPasskeyRpId', {
      onUpdate: {
        service: 'cognito-identity-provider', // ← ここを修正
        action: 'SetUserPoolMfaConfig',
        parameters: {
          UserPoolId: userPool.userPoolId,
          MfaConfiguration: 'OFF',
          WebAuthnConfiguration: {
            RelyingPartyId: `${domainPrefix}.auth.${this.region}.amazoncognito.com`,
            UserVerification: 'preferred',
          },
        },
        physicalResourceId: cr.PhysicalResourceId.of(`passkey-${Date.now()}`),
      },
      // サービス名からの IAM アクション推定に頼らず、明示する
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['cognito-idp:SetUserPoolMfaConfig'],
          resources: [userPool.userPoolArn],
        }),
      ]),
    });
    setPasskey.node.addDependency(userPoolDomain);

    userPool.addClient('WebClient', {
      generateSecret: false,
      authFlows: {
        user: true, // ALLOW_USER_AUTH
      },
    });

    // ---------- Cognito ユーザープールクライアント ----------
    const frontendUrl = `https://${distribution.distributionDomainName}`;
    const userPoolClient = userPool.addClient('AppClient', {
      userPoolClientName: 'todo-app-client',
      authFlows: {
        userSrp: true, // パスワードベース認証 (Cognito ホスト型UI用)
      },
      preventUserExistenceErrors: true,
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
        },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: [`${frontendUrl}/auth/callback`],
        logoutUrls: [frontendUrl],
      },
    });

    // ---------- DynamoDB テーブル (TODOリスト) ----------
    const todosTable = new dynamodb.Table(this, 'TodosTable', {
      tableName: `${this.stackName}-todos`,
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'todoId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const params = [
      {
        envName: 'APP_ORIGIN_PARAM',
        id: 'AppOriginParam',
        name: '/full-stack-html-app/cloudfront/origin',
        value: `https://${distribution.distributionDomainName}`,
      },
      {
        envName: 'CLIENT_ID_PARAM',
        id: 'AppClientIdParam',
        name: '/full-stack-html-app/cognito/app-client-id',
        value: userPoolClient.userPoolClientId,
      },
      {
        envName: 'COGNITO_USER_POOL_ID',
        id: 'UserPoolIdParam',
        name: '/full-stack-html-app/cognito/user-pool-id',
        value: userPool.userPoolId,
      },
      {
        envName: 'COGNITO_DOMAIN',
        id: 'CognitoDomainParam',
        name: '/full-stack-html-app/cognito/cognito-domain',
        value: userPoolDomain.domainName,
      },
      {
        envName: 'COOKIE_DOMAIN',
        id: 'CookieDomainParam',
        name: '/full-stack-html-app/frontend/cookie-domain',
        value: distribution.distributionDomainName,
      },
    ];

    // ---------- Lambda 関数 (NodejsFunction / TypeScript) ----------
    const apiHandler = new lambdaNodejs.NodejsFunction(this, 'CognitoBffHandler', {
      functionName: 'FullStackAppBffFunction',
      entry: 'lambda/cognito-bff/index.ts',
      handler: 'handler',
      timeout: Duration.seconds(60),
      memorySize: 512,
      architecture: lambda.Architecture.ARM_64,
      runtime: lambda.Runtime.NODEJS_24_X,
      bundling: {
        target: 'node24',
        externalModules: ['@aws-sdk/*'],
        forceDockerBundling: false,
        format: lambdaNodejs.OutputFormat.ESM,
        banner:
          "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
      },
      environment: {
        ...params
          .map(({ envName, name }) => ({ [envName]: name }))
          .reduce((acc, cur) => ({ ...acc, ...cur })),
        COGNITO_REGION: this.region,
        SESSION_SECRET_PARAM_NAME: sessionSecretParam.parameterName,
        TODOS_TABLE_NAME: todosTable.tableName,
      },
    });

    params.forEach((param) => {
      putParameter(param.id, param.name, param.value);
      apiHandler.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['ssm:GetParameter'],
          resources: [
            this.formatArn({
              service: 'ssm',
              resource: 'parameter',
              resourceName: param.name.replace(/^\//, ''),
            }),
          ],
        }),
      );
    });

    // DynamoDB テーブルの読み書き権限を Lambda に付与
    todosTable.grants.readWriteData(apiHandler);

    // SSM SecureString 読み取り権限 (復号を含む) - セッション鍵のみ
    sessionSecretParam.grantRead(apiHandler);

    // ---------- Lambda Function URL (CloudFront 専用オリジン) ----------
    const functionUrl = apiHandler.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
    });

    const paths = [
      {
        name: 'api',
        path: '/api/*',
      },
      {
        name: 'auth',
        path: '/auth/*',
      },
    ];

    const cachePolicy = new cloudfront.CachePolicy(this, 'ApiCachePolicy', {
      cachePolicyName: `${this.stackName}-api-cache`,
      comment: 'BFF API responses are not cached by default',
      defaultTtl: Duration.seconds(0),
      maxTtl: Duration.seconds(0),
      minTtl: Duration.seconds(0),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
    });
    const originRequestPolicy = new cloudfront.OriginRequestPolicy(this, 'ApiOriginRequestPolicy', {
      originRequestPolicyName: `${this.stackName}-api-origin-request`,
      comment: 'Forward all headers/cookies/query strings to BFF',
      cookieBehavior: cloudfront.OriginRequestCookieBehavior.all(),
      headerBehavior: cloudfront.OriginRequestHeaderBehavior.all(),
      queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.all(),
    });

    const responseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(
      this,
      'ResponseHeadersPolicy',
      {
        corsBehavior: {
          accessControlAllowOrigins: ['http://localhost:4173', 'http://localhost:5173'],
          accessControlAllowHeaders: ['*'],
          accessControlAllowMethods: ['ALL'],
          accessControlAllowCredentials: false,
          originOverride: true,
        },
      },
    );

    paths.forEach(({ name, path }) =>
      distribution.addBehavior(
        path,
        origins.FunctionUrlOrigin.withOriginAccessControl(functionUrl, {
          originId: name,
        }),
        {
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
          compress: true,
          cachePolicy,
          originRequestPolicy,
          responseHeadersPolicy,
        },
      ),
    );

    if (props.cloudFrontDomainName) {
      new cdk.CfnOutput(this, 'CustomDomainNote', {
        value: props.cloudFrontDomainName,
        description: 'CloudFront カスタムドメイン (Route53/ACM は別途設定してください)',
      });
    }

    // ---------- 出力 ----------
    new cdk.CfnOutput(this, 'FunctionUrl', {
      value: functionUrl.url,
      description: 'Lambda Function URL endpoint',
    });
    new cdk.CfnOutput(this, 'SessionSecretParamName', {
      value: sessionSecretParam.parameterName,
      description: 'BFF session secret SSM parameter name',
    });
    new cdk.CfnOutput(this, 'UserPoolId', {
      value: userPool.userPoolId,
      description: 'Cognito user pool ID',
    });
    new cdk.CfnOutput(this, 'CloudFrontDomainName', {
      value: distribution.distributionDomainName,
      description: 'CloudFront distribution domain name',
    });
    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: userPoolClient.userPoolClientId,
      description: 'Cognito user pool client ID',
    });
    new cdk.CfnOutput(this, 'UserPoolDomainOutput', {
      value: `https://${cognitoDomainName}`,
      description: 'Cognito user pool domain (hosted UI)',
    });
    new cdk.CfnOutput(this, 'AssetsBucketName', {
      value: s3bucket.bucketName,
      description: 'S3 bucket name for frontend uploads',
    });
    new cdk.CfnOutput(this, 'TodosTableName', {
      value: todosTable.tableName,
      description: 'DynamoDB table name for the TODO list',
    });
  }
}
