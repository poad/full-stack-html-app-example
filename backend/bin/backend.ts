#!/usr/bin/env node
import { BackendStack } from '../lib/backend-stack.js';

import * as cdk from 'aws-cdk-lib/core';

const app = new cdk.App();

const backend = new BackendStack(app, 'FullStackAppExample', {});
cdk.RemovalPolicies.of(backend).destroy();
