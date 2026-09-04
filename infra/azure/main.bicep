targetScope = 'subscription'

// AI-interview infrastructure — a deliberately small footprint (vs. the AI-Coach reference):
//   monitoring, managed-identity, container-registry, storage, container-apps (backend +
//   frontend only), github-oidc, role-assignments.
//
// Deliberately NOT created here (reused / not needed): Azure AI Foundry / OpenAI / Voice Live
// (an EXISTING resource in Sweden Central is reused — grant the backend MI access with
// scripts/grant-foundry-rbac.sh), PostgreSQL (the app keeps ephemeral SQLite, no DB PaaS),
// AI Search / Content Understanding / Speech-Avatar, and the prompt-optimizer sidecar.
//
// A VNet IS created (modules/network.bicep): the Container Apps environment is VNet-integrated so
// the backend can reach the storage account's blob private endpoint at boot (the policy-locked
// account has no public access) — this is what revives client-bank seeding.

@description('Short project/resource prefix (lowercase letters/numbers; several resources have strict naming rules).')
@minLength(3)
param namePrefix string = 'aiinterview'

@description('Deployment environment name.')
@allowed([
  'public'
])
param environmentName string = 'public'

@description('Azure region. Defaults to Sweden Central to co-locate with the existing AI Foundry resource.')
param location string = 'swedencentral'

@description('Optional resource group name. Leave empty to use rg-{namePrefix}-{environmentName}-{location}.')
param resourceGroupName string = ''

@description('Optional owner tag.')
param owner string = ''

@description('ACR name. Globally unique, lowercase alphanumeric, 5-50 chars.')
@minLength(5)
@maxLength(50)
param containerRegistryName string

@description('Storage account name. Globally unique, lowercase alphanumeric, 3-24 chars.')
@minLength(3)
@maxLength(24)
param storageAccountName string

@secure()
@description('JWT signing secret (backend SECRET_KEY). Do not commit real values.')
param secretKey string

@secure()
@description('Fernet encryption key for at-rest service-config secrets (backend ENCRYPTION_KEY). Do not commit real values.')
param encryptionKey string

@secure()
@description('Seeded admin password (backend SEED_ADMIN_PASSWORD). Empty disables admin seeding. Do not commit real values.')
param seedAdminPassword string = ''

@secure()
@description('Admin bearer token for admin routes (backend ADMIN_API_TOKEN). Do not commit real values.')
param adminApiToken string = ''

// Images are owned by the app-deploy pipeline (deploy-app.yml `az containerapp update --image`),
// NOT by infra. Default EMPTY = "preserve the currently-running image" so a steady-state infra
// re-apply is idempotent and never clobbers the pipeline-deployed image back to a placeholder
// (container-apps.bicep falls back to a helloworld placeholder only when the app doesn't exist yet).
// Pass a real ACR image tag ONLY on first-create or the env delete+recreate, when there is no
// running app to preserve.
@description('Backend container image. Empty (default) → preserve the running image (idempotent re-apply). Pass a real ACR tag on first-create / env recreate.')
param backendImage string = ''

@description('Frontend container image. Empty (default) → preserve the running image (idempotent re-apply). Pass a real ACR tag on first-create / env recreate.')
param frontendImage string = ''

@description('Blob name of the uploaded private client bundle zip. Empty → public-demo mode (generic bank only).')
param clientBundleBlob string = ''

@description('Existing Azure AI Foundry account endpoint (AZURE_FOUNDRY_ENDPOINT).')
param azureFoundryEndpoint string = ''

@description('Existing Foundry project endpoint (FOUNDRY_PROJECT_ENDPOINT).')
param foundryProjectEndpoint string = ''

@description('Existing Foundry default project name (AZURE_FOUNDRY_DEFAULT_PROJECT).')
param azureFoundryDefaultProject string = ''

@description('Interviewer-agent model deployment name (FOUNDRY_AGENT_MODEL). Must exist on the reused Foundry resource.')
param foundryAgentModel string = 'gpt-4o'

@description('Voice Live session model deployment name (VOICE_LIVE_DEFAULT_MODEL).')
param voiceLiveDefaultModel string = 'gpt-4o'

@description('Voice Live realtime api-version (VOICE_LIVE_API_VERSION).')
param voiceLiveApiVersion string = '2026-01-01-preview'

@description('GitHub repository owner/org for OIDC federation.')
param githubOwner string = 'huqianghui'

@description('GitHub repository name for OIDC federation.')
param githubRepo string = 'AI-interview-vibe-coding'

@description('GitHub branches allowed to deploy through OIDC (one federated credential per branch). main is the steady-state deploy branch.')
param githubBranches array = ['main']

@description('Optional GitHub numeric owner ID. Set alongside githubRepoId when the repo presents the immutable-ID OIDC subject form. Look up: gh api /repos/<owner>/<repo> --jq .owner.id')
param githubOwnerId string = ''

@description('Optional GitHub numeric repo ID. Set alongside githubOwnerId for the immutable-ID OIDC subject form. Look up: gh api /repos/<owner>/<repo> --jq .id')
param githubRepoId string = ''

@description('Optional GitHub Environment allowed to deploy through OIDC. Defaults to environmentName.')
param githubEnvironmentName string = environmentName

var locationToken = replace(toLower(location), ' ', '')
var effectiveResourceGroupName = empty(resourceGroupName) ? 'rg-${namePrefix}-${environmentName}-${locationToken}' : resourceGroupName
var deploymentName = '${namePrefix}-${environmentName}-${locationToken}'
var commonTags = union({
  project: 'ai-interview'
  environment: environmentName
  managedBy: 'bicep'
}, empty(owner) ? {} : {
  owner: owner
})

resource deploymentResourceGroup 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: effectiveResourceGroupName
  location: location
  tags: commonTags
}

module monitoring './modules/monitoring.bicep' = {
  name: '${deploymentName}-monitoring'
  scope: deploymentResourceGroup
  params: {
    namePrefix: namePrefix
    environmentName: environmentName
    location: location
    tags: commonTags
  }
}

module managedIdentity './modules/managed-identity.bicep' = {
  name: '${deploymentName}-managed-identity'
  scope: deploymentResourceGroup
  params: {
    namePrefix: namePrefix
    environmentName: environmentName
    location: location
    tags: commonTags
  }
}

module containerRegistry './modules/container-registry.bicep' = {
  name: '${deploymentName}-container-registry'
  scope: deploymentResourceGroup
  params: {
    namePrefix: namePrefix
    environmentName: environmentName
    location: location
    tags: commonTags
    registryName: containerRegistryName
  }
}

module storage './modules/storage.bicep' = {
  name: '${deploymentName}-storage'
  scope: deploymentResourceGroup
  params: {
    namePrefix: namePrefix
    environmentName: environmentName
    location: location
    tags: commonTags
    storageAccountName: storageAccountName
  }
}

module network './modules/network.bicep' = {
  name: '${deploymentName}-network'
  scope: deploymentResourceGroup
  params: {
    namePrefix: namePrefix
    environmentName: environmentName
    location: location
    tags: commonTags
    storageAccountId: storage.outputs.storageAccountId
    storageAccountName: storage.outputs.storageAccountName
  }
}

// The four runtime secrets are delivered as Container App NATIVE secrets (encrypted at rest by the
// platform), passed straight through as @secure() params below. They still never touch the repo
// (gitignored main.parameters).

module githubOidc './modules/github-oidc.bicep' = {
  name: '${deploymentName}-github-oidc'
  scope: deploymentResourceGroup
  params: {
    namePrefix: namePrefix
    environmentName: environmentName
    location: location
    tags: commonTags
    githubOwner: githubOwner
    githubRepo: githubRepo
    githubBranches: githubBranches
    githubOwnerId: githubOwnerId
    githubRepoId: githubRepoId
    githubEnvironmentName: githubEnvironmentName
  }
}

module roleAssignments './modules/role-assignments.bicep' = {
  name: '${deploymentName}-role-assignments'
  scope: deploymentResourceGroup
  params: {
    namePrefix: namePrefix
    environmentName: environmentName
    location: location
    tags: commonTags
    backendIdentityPrincipalId: managedIdentity.outputs.backendIdentityPrincipalId
    githubDeploymentPrincipalId: githubOidc.outputs.githubDeploymentPrincipalId
  }
}

module containerApps './modules/container-apps.bicep' = {
  name: '${deploymentName}-container-apps'
  scope: deploymentResourceGroup
  dependsOn: [
    roleAssignments
  ]
  params: {
    namePrefix: namePrefix
    environmentName: environmentName
    location: location
    tags: commonTags
    logAnalyticsWorkspaceName: monitoring.outputs.logAnalyticsWorkspaceName
    applicationInsightsConnectionString: monitoring.outputs.applicationInsightsConnectionString
    registryLoginServer: containerRegistry.outputs.registryLoginServer
    backendIdentityId: managedIdentity.outputs.backendIdentityId
    backendIdentityClientId: managedIdentity.outputs.backendIdentityClientId
    backendImage: backendImage
    frontendImage: frontendImage
    infrastructureSubnetId: network.outputs.infrastructureSubnetId
    secretKey: secretKey
    encryptionKey: encryptionKey
    seedAdminPassword: seedAdminPassword
    adminApiToken: adminApiToken
    storageAccountBlobEndpoint: storage.outputs.blobEndpoint
    clientBundleContainerName: storage.outputs.clientBundleContainerName
    clientBundleBlob: clientBundleBlob
    azureFoundryEndpoint: azureFoundryEndpoint
    foundryProjectEndpoint: foundryProjectEndpoint
    azureFoundryDefaultProject: azureFoundryDefaultProject
    foundryAgentModel: foundryAgentModel
    voiceLiveDefaultModel: voiceLiveDefaultModel
    voiceLiveApiVersion: voiceLiveApiVersion
  }
}

output resourceGroupName string = effectiveResourceGroupName
output location string = location
output tenantId string = tenant().tenantId
output containerRegistryName string = containerRegistry.outputs.registryName
output containerRegistryLoginServer string = containerRegistry.outputs.registryLoginServer
output storageAccountName string = storage.outputs.storageAccountName
output storageBlobEndpoint string = storage.outputs.blobEndpoint
output clientBundleContainerName string = storage.outputs.clientBundleContainerName
output backendContainerAppName string = containerApps.outputs.backendAppName
output frontendContainerAppName string = containerApps.outputs.frontendAppName
output backendUrl string = containerApps.outputs.backendUrl
output frontendUrl string = containerApps.outputs.frontendUrl
output natEgressIp string = network.outputs.natEgressIp
output backendIdentityName string = managedIdentity.outputs.backendIdentityName
output backendIdentityPrincipalId string = managedIdentity.outputs.backendIdentityPrincipalId
output githubDeploymentClientId string = githubOidc.outputs.githubDeploymentClientId

// Values to paste into infra/azure/environments/public.json (deploy workflow reads them).
output githubActions object = {
  AZURE_CLIENT_ID: githubOidc.outputs.githubDeploymentClientId
  AZURE_TENANT_ID: tenant().tenantId
  AZURE_SUBSCRIPTION_ID: subscription().subscriptionId
  AZURE_RESOURCE_GROUP: effectiveResourceGroupName
  ACR_NAME: containerRegistry.outputs.registryName
  BACKEND_APP_NAME: containerApps.outputs.backendAppName
  FRONTEND_APP_NAME: containerApps.outputs.frontendAppName
  HEALTH_CHECK: 'backend'
}
