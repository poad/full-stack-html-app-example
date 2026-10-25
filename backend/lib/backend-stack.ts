import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Duration } from 'aws-cdk-lib/core';

interface BackendStackProps extends cdk.StackProps {
  /** フロントエンド Origin URL (CORS 許可・ログアウト遷移先等に使用) */
  frontendUrl?: string;
  /** BFF セッション暗号化鍵 (SSM SecureString パラメータ名; 未指定時は自動作成) */
  sessionSecretParamName?: string;
  /** CloudFront のカスタムドメイン (指定時は出力のみ。Route53/ACM は別途設定) */
  cloudFrontDomainName?: string;
}

export class BackendStack extends cdk.Stack {
  public readonly apiHandler: lambdaNodejs.NodejsFunction;
  public readonly todosTable: dynamodb.Table;
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly userPoolDomain: cognito.UserPoolDomain;
  public readonly functionUrl: string;
  public readonly distribution: cloudfront.IDistribution;
  public readonly distributionDomainName: string;

  constructor(scope: Construct, id: string, props: BackendStackProps = {}) {
    super(scope, id, props);

    // ---------- セッション暗号化鍵 (SSM SecureString) ----------
    const sessionSecretParam = props.sessionSecretParamName
      ? ssm.StringParameter.fromStringParameterName(
          this,
          'SessionSecretParamImported',
          props.sessionSecretParamName,
        )
      : new ssm.StringParameter(this, 'SessionSecretParam', {
          parameterName: `/${this.stackName}/bff-session-secret`,
          description: 'BFF session encryption/signing secret',
          type: ssm.ParameterType.SECURE_STRING,
          stringValue: 'placeholder',
        });

    // ---------- Amazon Cognito ユーザープール ----------
    // パスキー (WebAuthn) は Cognito コンソールの「ユーザープール > ログイン > パスキー」
    // から有効化してください (CDK v2 での直接サポートは限定的です)。
    this.userPool = new cognito.UserPool(this, 'UserPool', {
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
    this.userPoolClient = this.userPool.addClient('AppClient', {
      userPoolClientName: 'todo-app-client',
      authFlows: {
        userSrp: true, // パスワードベース認証 (Cognito ホスト型UI用)
      },
      preventUserExistenceErrors: true,
      supportedIdentityProviders: [
        cognito.UserPoolClientIdentityProvider.COGNITO,
      ],
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
        },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
        ],
        callbackUrls: [
          `${props.frontendUrl ?? 'http://localhost:4321'}/auth/callback`,
        ],
        logoutUrls: [
          `${props.frontendUrl ?? 'http://localhost:4321'}`,
        ],
      },
    });

    // ---------- Cognito ユーザープールドメイン (ホスト型UI) ----------
    this.userPoolDomain = new cognito.UserPoolDomain(this, 'UserPoolDomain', {
      userPool: this.userPool,
      cognitoDomain: {
        domainPrefix: `${this.stackName}-${cdk.Fn.select(2, cdk.Fn.split('-', cdk.Aws.ACCOUNT_ID))}`,
      },
    });

    // ---------- DynamoDB テーブル (TODOリスト) ----------
    this.todosTable = new dynamodb.Table(this, 'TodosTable', {
      tableName: `${this.stackName}-todos`,
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'todoId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    this.todosTable.grantReadWriteData(this.apiHandler);
    this.apiHandler.addEnvironment('TODOS_TABLE_NAME', this.todosTable.tableName);

    // ---------- Cognito ユーザープールドメイン (ホスト型UI) ----------
    this.userPoolDomain = new cognito.UserPoolDomain(this, 'UserPoolDomain', {
      userPool: this.userPool,
      cognitoDomain: {
        domainPrefix: `${this.stackName}-domain`,
      },
    });

    // ---------- Lambda 関数 (NodejsFunction / TypeScript) ----------
    this.apiHandler = new lambdaNodejs.NodejsFunction(this, 'CognitoBffHandler', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.X86_64,
      entry: 'lambda/cognito-bff/index.ts',
      handler: 'handler',
      timeout: Duration.seconds(30),
      memorySize: 256,
      bundling: {
        externalModules: ['aws-sdk'],
        forceDockerBundling: false,
      },
      environment: {
        COGNITO_USER_POOL_ID: this.userPool.userPoolId,
        COGNITO_CLIENT_ID: this.userPoolClient.userPoolClientId,
        COGNITO_DOMAIN: this.userPoolDomain.domainName,
        COGNITO_REGION: this.region,
        SESSION_SECRET_PARAM_NAME: sessionSecretParam.parameterName,
        FRONTEND_URL: props.frontendUrl ?? '',
        COOKIE_DOMAIN: '',
      },
    });

    // SSM SecureString 読み取り権限 (復号を含む) - セッション鍵のみ
    sessionSecretParam.grantRead(this.apiHandler);

    // ---------- Lambda Function URL (CloudFront 専用オリジン) ----------
    const functionUrl = this.apiHandler.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
      cors: {
        allowedOrigins: [props.frontendUrl ?? '*'],
        allowedMethods: [lambda.HttpMethod.ALL],
        allowedHeaders: ['*'],
        allowCredentials: props.frontendUrl ? true : false,
        maxAge: Duration.seconds(86400),
      },
    });
    this.functionUrl = functionUrl.url;

    // ---------- CloudFront ディストリビューション (Lambda Function URL オリジン) ----------
    const apiOrigin = origins.FunctionUrlOrigin.withOriginAccessControl(
      functionUrl,
    );

    this.distribution = new cloudfront.Distribution(this, 'EntraBffDistribution', {
      defaultBehavior: {
        origin: apiOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
        compress: true,
        cachePolicy: new cloudfront.CachePolicy(this, 'ApiCachePolicy', {
          cachePolicyName: `${this.stackName}-api-cache`,
          comment: 'BFF API responses are not cached by default',
          defaultTtl: Duration.seconds(0),
          maxTtl: Duration.seconds(0),
          minTtl: Duration.seconds(0),
          cookieBehavior: cloudfront.CacheCookieBehavior.all(),
          headerBehavior: cloudfront.CacheHeaderBehavior.allowList(
            'cookie',
            'origin',
          ),
          queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
        }),
        originRequestPolicy: new cloudfront.OriginRequestPolicy(
          this,
          'ApiOriginRequestPolicy',
          {
            originRequestPolicyName: `${this.stackName}-api-origin-request`,
            comment: 'Forward all headers/cookies/query strings to BFF',
            cookieBehavior: cloudfront.OriginRequestCookieBehavior.all(),
            headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList(
              'cookie',
              'origin',
            ),
            queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.all(),
          },
        ),
        functionAssociations: [
          {
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
            function: new cloudfront.Function(this, 'SecurityHeadersFunction', {
              code: cloudfront.FunctionCode.fromInline(`
                function handler(event) {
                  var response = event.response;
                  var headers = response.headers;
                  headers['strict-transport-security'] = { value: 'max-age=31536000; includeSubDomains' };
                  headers['x-content-type-options'] = { value: 'nosniff' };
                  headers['x-frame-options'] = { value: 'DENY' };
                  headers['referrer-policy'] = { value: 'no-referrer' };
                  headers['content-security-policy'] = { value: "default-src 'self'" };
                  return response;
                }
              `),
            }),
          },
        ],
      },
      comment: `${this.stackName} - Cognito BFF distribution (Lambda Function URL)`,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      enabled: true,
    });

    if (props.cloudFrontDomainName) {
      new cdk.CfnOutput(this, 'CustomDomainNote', {
        value: props.cloudFrontDomainName,
        description: 'CloudFront カスタムドメイン (Route53/ACM は別途設定してください)',
      });
    }

    // ---------- 出力 ----------
    new cdk.CfnOutput(this, 'FunctionUrl', {
      value: this.functionUrl,
      description: 'Lambda Function URL エンドポイント',
    });
    new cdk.CfnOutput(this, 'CloudFrontDomainName', {
      value: this.distribution.distributionDomainName,
      description: 'CloudFront ディストリビューション ドメイン名',
    });
    new cdk.CfnOutput(this, 'CloudFrontDistributionId', {
      value: this.distribution.distributionId,
      description: 'CloudFront ディストリビューション ID',
    });
    new cdk.CfnOutput(this, 'SessionSecretParamName', {
      value: sessionSecretParam.parameterName,
      description: 'BFF セッションシークレット SSM パラメータ名',
    });
    new cdk.CfnOutput(this, 'UserPoolId', {
      value: this.userPool.userPoolId,
      description: 'Cognito ユーザープール ID',
    });
    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: this.userPoolClient.userPoolClientId,
      description: 'Cognito ユーザープールクライアント ID',
    });
    new cdk.CfnOutput(this, 'UserPoolDomain', {
      value: `https://${this.userPoolDomain.domainName}`,
      description: 'Cognito ユーザープールドメイン (ホスト型UI)',
    });
    new cdk.CfnOutput(this, 'TodosTableName', {
      value: this.todosTable.tableName,
      description: 'TODOリスト用 DynamoDB テーブル名',
    });
  }
}
