import * as iam from 'aws-cdk-lib/aws-iam';
import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';

export class DeployRoleStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const repositoryId = this.node.tryGetContext('repository-id');
    const repositoryOwnerId = this.node.tryGetContext('repository-owner-id');

    const cdkDeployPolicy = iam.ManagedPolicy.fromManagedPolicyName(
      this,
      'CdkDeployPolicy',
      'CdkDeployMinimalPolicy',
    );

    new iam.Role(this, 'Role', {
      roleName: 'strands-agent-lambda-example-deploy-role',
      assumedBy: new iam.FederatedPrincipal(
        `arn:aws:iam::${this.account}:oidc-provider/token.actions.githubusercontent.com`,
        {
          StringEquals: {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
            'token.actions.githubusercontent.com:repository_id': repositoryId,
            'token.actions.githubusercontent.com:repository_owner_id': repositoryOwnerId,
          },
          StringLike: {
            'token.actions.githubusercontent.com:sub': ['repo:poad/*', 'repo:poad@*'],
          },
        },
        'sts:AssumeRoleWithWebIdentity',
      ).withSessionTags(),
      managedPolicies: [cdkDeployPolicy],
      inlinePolicies: {
        'iam-policy': new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'AttachRolePolicy',
                'CreateRole',
                'CreatePolicy',
                'CreatePolicyVersion',
                'CreateServiceLinkedRole',
                'DeletePolicy',
                'DeletePolicyVersion',
                'DeleteRole',
                'DeleteRolePermissionsBoundary',
                'DeleteRolePolicy',
                'GetPolicy',
                'GetPolicyVersion',
                'GetRole',
                'GetRolePolicy',
                'ListAttachedRolePolicies',
                'ListPolicies',
                'ListPoliciesGrantingServiceAccess',
                'ListPolicyTags',
                'ListPolicyVersions',
                'ListRolePolicies',
                'ListRoleTags',
                'ListRoles',
                'PutRolePermissionsBoundary',
                'PutRolePolicy',
                'TagPolicy',
                'TagRole',
                'UntagPolicy',
                'UntagRole',
                'UpdateRole',
                'UpdateRoleDescription',
              ].map((action) => `iam:${action}`),
              resources: ['*'],
            }),
          ],
        }),
      },
    });
  }
}
