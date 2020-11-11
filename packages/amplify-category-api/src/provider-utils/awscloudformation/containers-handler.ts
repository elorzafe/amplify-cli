import fs from 'fs-extra';
import path from 'path';
import { ServiceConfiguration } from './service-walkthroughs/containers-walkthrough';
import { containerFiles } from './container-artifacts';
import { DEPLOYMENT_MECHANISM } from './ecs-stack';
import { GitHubSourceActionInfo } from './PipelineWithAwaiter';

export const addResource = async (serviceWalkthroughPromise: Promise<ServiceConfiguration>, context, category, service, options) => {
  const { checkRequirements, externalAuthEnable } = await import('amplify-category-auth');

  const projectBackendDirPath = context.amplify.pathManager.getBackendDirPath();
  const walkthroughOptions = await serviceWalkthroughPromise;

  const { resourceName, restrictAccess, imageTemplate, githubPath, githubToken, deploymentMechanism } = walkthroughOptions;
  const resourceDirPath = path.join(projectBackendDirPath, category, resourceName);

  const dependsOn = [];

  // TODO: Find a place to put this
  // for now copied from NETWORK_STACK_LOGICAL_ID (amplify-provider-awscloudformation/src/network/stack.ts)
  const x = 'NetworkStack';
  dependsOn.push(
    {
      "category": "",
      "resourceName": x,
      "attributes": [
        "ClusterName",
        "VpcId",
        "VpcCidrBlock",
        "SubnetIds",
        "VpcLinkId",
        "CloudMapNamespaceId"
      ]
    });

  let authName;

  if (restrictAccess) {

    const apiRequirements = { authSelections: 'identityPoolAndUserPool' };
    // getting requirement satisfaction map
    const satisfiedRequirements = await checkRequirements(apiRequirements, context, category, resourceName);
    // checking to see if any requirements are unsatisfied
    const foundUnmetRequirements = Object.values(satisfiedRequirements).includes(false);

    if (foundUnmetRequirements) {
      try {
        authName = await externalAuthEnable(context, 'api', resourceName, apiRequirements);
      } catch (e) {
        context.print.error(e);
        throw e;
      }
    } else {
      [authName] = Object.keys(context.amplify.getProjectDetails().amplifyMeta.auth);
    }
    dependsOn.push(
      {
        "category": "auth",
        "resourceName": authName,
        "attributes": [
          "UserPoolId",
          "AppClientIDWeb"
        ]
      });
  }

  //#region Add token to secrets manager and get arn
  const { StackName } = context.amplify.getProjectDetails().amplifyMeta.providers['awscloudformation'];
  
  const secretName = `${StackName}-${category}-${resourceName}-github-token`;
  const { ARN: secretArn } = await context.amplify.executeProviderUtils(context, 'awscloudformation', 'newSecret', {
    secret: githubToken,
    description: 'GitHub OAuth token',
    name: secretName,
    version: secretName
  });
  
  const githubTokenSecretArn = secretArn;

  const githubInfo: GitHubSourceActionInfo = deploymentMechanism === DEPLOYMENT_MECHANISM.INDENPENDENTLY_MANAGED ? {
    path: githubPath,
    tokenSecretArn: githubTokenSecretArn
  } : undefined;

  //#endregion

  options = {
    resourceName,
    dependsOn,
    ...walkthroughOptions,
    build: true,
    providerPlugin: 'awscloudformation',
    service: 'ElasticContainer',
    githubInfo,
    authName
  };

  fs.ensureDirSync(resourceDirPath);
  fs.ensureDirSync(path.join(resourceDirPath, 'src'));

  Object.entries(containerFiles).forEach(([fileName, fileContents]) => {
    fs.writeFileSync(path.join(resourceDirPath, 'src', fileName), fileContents);
  });

  context.amplify.updateamplifyMetaAfterResourceAdd(category, resourceName, options);

  return resourceName;
}