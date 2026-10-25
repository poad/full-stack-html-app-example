#!/usr/bin/env node
import { BackendStack } from '../lib/backend-stack.js';
import { CloudFrontStack } from '../lib/cloudfront-stack.js';

import * as cdk from 'aws-cdk-lib/core';

const app = new cdk.App();

const cloudfront = new CloudFrontStack(app, 'FullStackHtmlAppExampleCloudFront');

const backend = new BackendStack(app, 'FullStackHtmlAppExampleBackend', {
  distribution: cloudfront.distribution,
});
backend.addStackDependency(cloudfront);

cdk.RemovalPolicies.of(cloudfront).destroy();
cdk.RemovalPolicies.of(backend).destroy();
