import * as codebuild from '@aws-cdk/aws-codebuild';
import * as codepipeline from '@aws-cdk/aws-codepipeline';
import * as codepipelineactions from '@aws-cdk/aws-codepipeline-actions';
import * as ecr from '@aws-cdk/aws-ecr';
import * as ecs from '@aws-cdk/aws-ecs';
import * as iam from '@aws-cdk/aws-iam';
import * as lambda from '@aws-cdk/aws-lambda';
import * as s3 from '@aws-cdk/aws-s3';
import * as cdk from '@aws-cdk/core';
import * as custom from '@aws-cdk/custom-resources';
import fs from 'fs-extra';
import path from 'path';
import { DEPLOYMENT_MECHANISM } from './ecs-stack';
import { getGitHubOwnerRepoFromPath } from './utils/github';

type PipelineAwaiterProps = {
  pipeline: codepipeline.Pipeline;
  artifactBucketName?: string;
  artifactKey?: string;
  deploymentMechanism: DEPLOYMENT_MECHANISM;
};

export type GitHubSourceActionInfo = {
  path: string;
  tokenSecretArn: string;
};

class PipelineAwaiter extends cdk.Construct {
  constructor(scope: cdk.Construct, id: string, props: PipelineAwaiterProps) {
    const { pipeline, artifactBucketName, artifactKey, deploymentMechanism } = props;

    const { pipelineArn, pipelineName } = pipeline;

    const onEventHandler = new lambda.Function(scope, `${id}CustomEventHandler`, {
      runtime: lambda.Runtime.NODEJS_12_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`exports.handler = async function ({ RequestType, PhysicalResourceId, ResourceProperties }) {
                switch (RequestType) {
                    case 'Delete':
                    case 'Update':
                        return { PhysicalResourceId };
                }

                const { pipelineName } = ResourceProperties;

                const result = {
                    PhysicalResourceId: \`pipelineawaiter-\${pipelineName}\`
                };

                return result;
            };`),
      timeout: cdk.Duration.minutes(5),
    });

    const pipelineCodeFilePath = path.join(__dirname, 'lambdas', 'pipeline.js');
    const isCompleteHandlerCode = fs.readFileSync(pipelineCodeFilePath, 'utf8');

    const isCompleteHandler = new lambda.Function(scope, `${id}CustomCompleteHandler`, {
      runtime: lambda.Runtime.NODEJS_12_X,
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(25),
      code: lambda.Code.fromInline(isCompleteHandlerCode),
      environment: {
        // TODO: Move to custom resource properties
        PIPELINE_NAME: pipelineName,
        ARTIFACT_BUCKET_NAME: artifactBucketName,
        ARTIFACT_KEY: artifactKey,
        DEPLOYMENT_MECHANISM: deploymentMechanism,
      },
    });
    isCompleteHandler.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['codepipeline:GetPipeline', 'codepipeline:ListPipelineExecutions'],
        resources: [pipelineArn],
      }),
    );
    isCompleteHandler.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudformation:DescribeStacks'],
        resources: [cdk.Stack.of(scope).stackId],
      }),
    );

    const myProvider = new custom.Provider(scope, `${id}MyProvider`, {
      onEventHandler,
      isCompleteHandler,
      queryInterval: cdk.Duration.seconds(10),
    });

    const customResource = new cdk.CustomResource(scope, `Deployment${id}`, {
      serviceToken: myProvider.serviceToken,
      properties: {
        artifactKey,
        pipelineName,
      },
    });

    super(scope, id);
  }
}

export class PipelineWithAwaiter extends cdk.Construct {
  constructor(
    scope: cdk.Construct,
    id: string,
    {
      bucket,
      s3SourceActionKey,
      service,
      deploymentMechanism,
      githubSourceActionInfo,
      containersInfo,
      desiredCount,
    }: {
      bucket: s3.IBucket;
      s3SourceActionKey?: string;
      deploymentMechanism: DEPLOYMENT_MECHANISM;
      githubSourceActionInfo?: GitHubSourceActionInfo;
      service: ecs.CfnService;
      containersInfo: {
        container: ecs.ContainerDefinition;
        repository: ecr.Repository;
      }[];
      desiredCount: number;
    },
  ) {
    super(scope, id);

    const sourceOutput = new codepipeline.Artifact('SourceArtifact');
    const buildOutput = new codepipeline.Artifact('BuildArtifact');

    const codebuildproject = new codebuild.PipelineProject(scope, `${id}CodeBuildProject`, {
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_4_0,
        privileged: true,
      },
    });

    if (githubSourceActionInfo && githubSourceActionInfo.tokenSecretArn) {
      codebuildproject.addToRolePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            'secretsmanager:GetRandomPassword',
            'secretsmanager:GetResourcePolicy',
            'secretsmanager:GetSecretValue',
            'secretsmanager:DescribeSecret',
            'secretsmanager:ListSecretVersionIds',
          ],
          resources: [githubSourceActionInfo.tokenSecretArn],
        }),
      );
    }

    if (codebuildproject.role) {
      codebuildproject.role.addToPrincipalPolicy(
        new iam.PolicyStatement({
          resources: ['*'],
          actions: [
            'ecr:GetAuthorizationToken',
            'ecr:BatchGetImage',
            'ecr:BatchGetDownloadUrlForLayer',
            'ecr:InitiateLayerUpload',
            'ecr:BatchCheckLayerAvailability',
            'ecr:UploadLayerPart',
            'ecr:CompleteLayerUpload',
            'ecr:PutImage',
          ],
          effect: iam.Effect.ALLOW,
        }),
      );
    }

    const preBuildStages = createPreBuildStages(scope, {
      bucket,
      s3SourceActionKey,
      githubSourceActionInfo,
      roleName: 'UpdateSource',
      sourceOutput,
    });

    const environmentVariables = containersInfo.reduce((acc, c) => {
      acc[`${c.container.containerName}_REPOSITORY_URI`] = {
        type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
        value: c.repository.repositoryUri,
      };

      return acc;
    }, {} as Record<string, codebuild.BuildEnvironmentVariable>);

    const stagesWithDeploy = ([] as codepipeline.StageOptions[]).concat(preBuildStages, [
      {
        stageName: 'Build',
        actions: [
          new codepipelineactions.CodeBuildAction({
            role: getRole(scope, 'UpdateBuild'),
            actionName: 'Build',
            type: codepipelineactions.CodeBuildActionType.BUILD,
            project: codebuildproject,
            input: sourceOutput,
            outputs: [buildOutput],
            environmentVariables,
          }),
        ],
      },
      {
        stageName: 'PreDeploy',
        actions: [
          new codepipelineactions.LambdaInvokeAction({
            actionName: 'PreDeploy',
            lambda: (() => {
              const preDeployCodeFilePath = path.join(__dirname, 'lambdas', 'predeploy.js');
              const lambdaHandlerCode = fs.readFileSync(preDeployCodeFilePath, 'utf8');

              const action = new lambda.Function(scope, 'PreDeployLambda', {
                code: lambda.InlineCode.fromInline(lambdaHandlerCode),
                handler: 'index.handler',
                runtime: lambda.Runtime.NODEJS_12_X,
                environment: {
                  DESIRED_COUNT: `${desiredCount}`,
                  CLUSTER_NAME: service.cluster,
                  SERVICE_NAME: service.serviceName,
                },
              });

              action.addToRolePolicy(
                new iam.PolicyStatement({
                  actions: ['ecs:UpdateService'],
                  effect: iam.Effect.ALLOW,
                  resources: [cdk.Fn.ref(service.logicalId)],
                }),
              );

              return action;
            })(),
            inputs: [],
            outputs: [],
          }),
        ],
      },
      {
        stageName: 'Deploy',
        actions: [
          new codepipelineactions.EcsDeployAction({
            role: getRole(scope, 'UpdateDeploy'),
            actionName: 'Deploy',
            service: new (class extends cdk.Construct implements ecs.IBaseService {
              cluster = {
                clusterName: service.cluster,
                env: {},
              } as ecs.ICluster;
              serviceArn = cdk.Fn.ref(service.serviceArn);
              serviceName = service.serviceName;
              stack = cdk.Stack.of(this);
              env = {} as any;
              node = service.node;
            })(this, 'tmpService'), // TODO: clean this,
            input: buildOutput,
          }),
        ],
      },
    ]);

    const role = getRole(scope, `Pipeline`, new iam.ServicePrincipal('codepipeline.amazonaws.com'));

    const pipeline = new codepipeline.Pipeline(scope, `${id}Pipeline`, {
      pipelineName: `codepipeline-amplify-${service.serviceName}`,
      crossAccountKeys: false,
      artifactBucket: bucket,
      stages: stagesWithDeploy,
      role,
    });

    pipeline.node.addDependency(service);

    const pipelineAwaiter = new PipelineAwaiter(scope, 'Awaiter', {
      pipeline,
      artifactBucketName: bucket.bucketName,
      artifactKey: s3SourceActionKey,
      deploymentMechanism,
    });
  }
}

function createPreBuildStages(
  scope: cdk.Construct,
  {
    bucket,
    s3SourceActionKey,
    githubSourceActionInfo,
    sourceOutput,
    roleName,
  }: {
    bucket: s3.IBucket;
    s3SourceActionKey: string;
    githubSourceActionInfo?: GitHubSourceActionInfo;
    sourceOutput: codepipeline.Artifact;
    roleName: string;
  },
) {
  const stages: codepipeline.StageOptions[] = [];

  const stage = {
    stageName: 'Source',
    actions: [],
  };

  stages.push(stage);

  if (githubSourceActionInfo && githubSourceActionInfo.path) {
    const { path, tokenSecretArn } = githubSourceActionInfo;
    const { owner, repo, branch } = getGitHubOwnerRepoFromPath(path);

    const preBuildOutput = new codepipeline.Artifact('PreBuildArtifact');

    stage.actions = [
      new codepipelineactions.GitHubSourceAction({
        actionName: 'Source',
        oauthToken: cdk.SecretValue.secretsManager(tokenSecretArn),
        owner,
        repo,
        branch,
        output: preBuildOutput,
      }),
    ];

    stages.push({
      stageName: 'PreBuild',
      actions: [
        new codepipelineactions.LambdaInvokeAction({
          actionName: 'PreBuild',
          lambda: new lambda.Function(scope, 'PreBuildLambda', {
            code: lambda.S3Code.fromBucket(bucket, 'codepipeline-action-buildspec-generator-lambda.zip'),
            handler: 'index.handler',
            runtime: lambda.Runtime.NODEJS_12_X,
          }),
          inputs: [preBuildOutput],
          outputs: [sourceOutput],
        }),
      ],
    });
  } else {
    stage.actions = [
      new codepipelineactions.S3SourceAction({
        role: getRole(scope, roleName),
        actionName: 'Source',
        bucket,
        bucketKey: s3SourceActionKey,
        output: sourceOutput,
      }),
    ];
  }

  return stages;
}

function getRole(scope: cdk.Construct, prefix: string, assumedBy?: iam.IPrincipal): iam.Role {
  const role = new iam.Role(scope, `${prefix}Role`, {
    assumedBy: assumedBy ?? new iam.AccountRootPrincipal(),
  });

  const cfnRole = role.node.defaultChild as iam.CfnRole;

  // We add a dummy statement that we immediately remove so CDK creates a policy to which we can add a condition
  const defaultPolicy = role.addToPrincipalPolicy(
    new iam.PolicyStatement({
      actions: ['*'],
      effect: iam.Effect.DENY,
    }),
  ).policyDependable as iam.Policy;
  (defaultPolicy.document as any).statements = [];

  return role;
}

export type ContainerStackProps = {
  deploymentBucket: string;
  containerPort: number;
  awaiterZipPath: string;
  githubPath?: string;
  githubTokenSecretsManagerArn: string;
};
