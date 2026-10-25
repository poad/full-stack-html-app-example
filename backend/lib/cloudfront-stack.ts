import { buildCfFunction } from './process/setup.js';

import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';

interface CloudFrontStackProps extends cdk.StackProps {
  /** BFF セッション暗号化鍵 (SSM SecureString パラメータ名; 未指定時は自動作成) */
  readonly sessionSecretParamName?: string;
  /** CloudFront のカスタムドメイン (指定時は出力のみ。Route53/ACM は別途設定) */
  readonly cloudFrontDomainName?: string;
}

export class CloudFrontStack extends cdk.Stack {
  // oxlint-disable-next-line awscdk(no-construct-in-public-property-of-construct)
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: CloudFrontStackProps = {}) {
    super(scope, id, props);

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
    this.distribution = distribution;

    if (props.cloudFrontDomainName) {
      new cdk.CfnOutput(this, 'CustomDomainNote', {
        value: props.cloudFrontDomainName,
        description: 'CloudFront カスタムドメイン (Route53/ACM は別途設定してください)',
      });
    }

    // ---------- 出力 ----------
    new cdk.CfnOutput(this, 'CloudFrontDomainName', {
      value: distribution.distributionDomainName,
      description: 'CloudFront ディストリビューション ドメイン名',
    });
    new cdk.CfnOutput(this, 'CloudFrontDistributionId', {
      value: distribution.distributionId,
      description: 'CloudFront ディストリビューション ID',
    });
    new cdk.CfnOutput(this, 'AssetsBucketName', {
      value: s3bucket.bucketName,
      description: 'フロントエンドアップロード先 S3 バケット名',
    });
  }
}
