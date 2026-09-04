targetScope = 'resourceGroup'

// RBAC grants, all scoped to this resource group:
//   backend MI  → AcrPull (pull images), Storage Blob Data Reader (pull the client bundle).
//   github MI   → Contributor (containerapp update / acr build), AcrPush (push images).
// NOTE: no secrets-store role is needed — runtime secrets are Container App native secrets (see
// container-apps.bicep / main.bicep).
// NOTE: access to the EXISTING Azure AI Foundry account (a different RG) is granted separately by
// scripts/grant-foundry-rbac.sh — it is out of this resource group's scope.

param namePrefix string
param environmentName string
param location string
param tags object

param backendIdentityPrincipalId string
param githubDeploymentPrincipalId string

@description('Create the GitHub-deploy MI role assignments (Contributor + AcrPush). Default true keeps the GitHub Actions auto-deploy path. Set false for a client hand-off deployment that publishes manually with its own AAD (no GitHub OIDC) — the backend MI grants below are always created.')
param enableGithubOidc bool = true

var acrPullRoleDefinitionId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
var acrPushRoleDefinitionId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '8311e382-0749-4cb8-b61a-304f252e45ec')
var contributorRoleDefinitionId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b24988ac-6180-42a0-ab88-20f7382dd24c')
var storageBlobDataReaderRoleDefinitionId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1')

resource backendAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, backendIdentityPrincipalId, 'acr-pull')
  properties: {
    principalId: backendIdentityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: acrPullRoleDefinitionId
  }
}

resource backendStorageBlobDataReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, backendIdentityPrincipalId, 'storage-blob-data-reader')
  properties: {
    principalId: backendIdentityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: storageBlobDataReaderRoleDefinitionId
  }
}

// GitHub-deploy MI grants — created only when the GitHub OIDC auto-deploy path is enabled. In a
// client hand-off deployment (enableGithubOidc=false) there is no GitHub identity to grant, and the
// principalId is passed empty; the !empty guard keeps guid()/the resource valid in that case.
resource githubDeploymentContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (enableGithubOidc && !empty(githubDeploymentPrincipalId)) {
  name: guid(resourceGroup().id, githubDeploymentPrincipalId, 'github-deployment-contributor')
  properties: {
    principalId: githubDeploymentPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: contributorRoleDefinitionId
  }
}

resource githubDeploymentAcrPush 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (enableGithubOidc && !empty(githubDeploymentPrincipalId)) {
  name: guid(resourceGroup().id, githubDeploymentPrincipalId, 'github-deployment-acr-push')
  properties: {
    principalId: githubDeploymentPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: acrPushRoleDefinitionId
  }
}

output summary object = {
  module: 'role-assignments'
  namePrefix: namePrefix
  environmentName: environmentName
  location: location
  tags: tags
  scope: resourceGroup().id
  backendIdentityPrincipalId: backendIdentityPrincipalId
  githubDeploymentPrincipalId: githubDeploymentPrincipalId
  resources: union([
    backendAcrPull.name
    backendStorageBlobDataReader.name
  ], (enableGithubOidc && !empty(githubDeploymentPrincipalId)) ? [
    githubDeploymentContributor.name
    githubDeploymentAcrPush.name
  ] : [])
}
