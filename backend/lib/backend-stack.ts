import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cdk from 'aws-cdk-lib/core';
import { Duration } from 'aws-cdk-lib/core';
import { Construct } from 'constructs';

interface BackendStackProps extends cdk.StackProps {
  readonly distribution: cloudfront.Distribution;
  /** BFF セッション暗号化鍵 (SSM SecureString パラメータ名; 未指定時は自動作成) */
  readonly sessionSecretParamName?: string;
  /** CloudFront のカスタムドメイン (指定時は出力のみ。Route53/ACM は別途設定) */
  readonly cloudFrontDomainName?: string;
}

export class BackendStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: BackendStackProps) {
    super(scope, id, props);

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
    // パスキー (WebAuthn) は Cognito コンソールの「ユーザープール > ログイン > パスキー」
    // から有効化してください (CDK v2 での直接サポートは限定的です)。
    const userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `${this.stackName}-user-pool`,
      signInAliases: { email: true },
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
      mfa: cognito.Mfa.OPTIONAL,
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      selfSignUpEnabled: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ---------- Cognito ユーザープールクライアント ----------
    const frontendUrl = `https://${props.distribution.distributionDomainName}`;
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

    // ---------- Cognito ユーザープールドメイン (ホスト型UI) ----------
    const userPoolDomain = new cognito.UserPoolDomain(this, 'UserPoolDomain', {
      userPool: userPool,
      cognitoDomain: {
        domainPrefix: `${this.stackName.toLowerCase().replace(/[^a-z0-9-]/g, '-')}-domain`,
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

    // ---------- Lambda 関数 (NodejsFunction / TypeScript) ----------
    const apiHandler = new lambdaNodejs.NodejsFunction(this, 'CognitoBffHandler', {
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      entry: 'lambda/cognito-bff/index.ts',
      handler: 'handler',
      timeout: Duration.seconds(60),
      memorySize: 512,
      bundling: {
        externalModules: ['@aws-sdk/*'],
        forceDockerBundling: false,
      },
      environment: {
        COGNITO_USER_POOL_ID: userPool.userPoolId,
        COGNITO_CLIENT_ID: userPoolClient.userPoolClientId,
        COGNITO_DOMAIN: userPoolDomain.domainName,
        COGNITO_REGION: this.region,
        SESSION_SECRET_PARAM_NAME: sessionSecretParam.parameterName,
        TODOS_TABLE_NAME: todosTable.tableName,
        FRONTEND_URL: `https://${props.distribution.distributionDomainName}/`,
        COOKIE_DOMAIN: props.distribution.distributionDomainName,
      },
    });

    // DynamoDB テーブルの読み書き権限を Lambda に付与
    todosTable.grants.readWriteData(apiHandler);

    // SSM SecureString 読み取り権限 (復号を含む) - セッション鍵のみ
    sessionSecretParam.grantRead(apiHandler);

    // ---------- Lambda Function URL (CloudFront 専用オリジン) ----------
    const functionUrl = apiHandler.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
      cors: {
        allowedOrigins: frontendUrl ? [frontendUrl] : ['*'],
        allowedMethods: [lambda.HttpMethod.ALL],
        allowedHeaders: ['*'],
        allowCredentials: frontendUrl ? true : false,
        maxAge: Duration.seconds(86400),
      },
    });

    const s3bucket = new s3.Bucket(this, 'S3Bucket', {
      bucketName: 'full-stack-html-app-example-assets',
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
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
      props.distribution.addBehavior(
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
      description: 'Lambda Function URL エンドポイント',
    });
    new cdk.CfnOutput(this, 'SessionSecretParamName', {
      value: sessionSecretParam.parameterName,
      description: 'BFF セッションシークレット SSM パラメータ名',
    });
    new cdk.CfnOutput(this, 'UserPoolId', {
      value: userPool.userPoolId,
      description: 'Cognito ユーザープール ID',
    });
    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: userPoolClient.userPoolClientId,
      description: 'Cognito ユーザープールクライアント ID',
    });
    new cdk.CfnOutput(this, 'UserPoolDomainOutput', {
      value: `https://${userPoolDomain.domainName}.auth.us-west-2.amazoncognito.com`,
      description: 'Cognito ユーザープールドメイン (ホスト型UI)',
    });
    new cdk.CfnOutput(this, 'AssetsBucketName', {
      value: s3bucket.bucketName,
      description: 'フロントエンドアップロード先 S3 バケット名',
    });
    new cdk.CfnOutput(this, 'TodosTableName', {
      value: todosTable.tableName,
      description: 'TODOリスト用 DynamoDB テーブル名',
    });
  }
}
