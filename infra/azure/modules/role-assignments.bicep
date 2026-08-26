targetScope = 'resourceGroup'

// RBAC grants, all scoped to this resource group:
//   backend MI  → AcrPull (pull images), Storage Blob Data Reader (pull the client bundle).
//   github MI   → Contributor (containerapp update / acr build), AcrPush (push images).
// NOTE: no Key Vault Secrets User — this subscription's policy force-disables KV public access, so
// runtime secrets are Container App native secrets (see container-apps.bicep / main.bicep), not KV.
// NOTE: access to the EXISTING Azure AI Foundry account (a different RG) is granted separately by
// scripts/grant-foundry-rbac.sh — it is out of this resource group's scope.

param namePrefix string
param environmentName string
param location string
param tags object

param backendIdentityPrincipalId string
param githubDeploymentPrincipalId string

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

resource githubDeploymentContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, githubDeploymentPrincipalId, 'github-deployment-contributor')
  properties: {
    principalId: githubDeploymentPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: contributorRoleDefinitionId
  }
}

resource githubDeploymentAcrPush 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
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
  resources: [
    backendAcrPull.name
    backendStorageBlobDataReader.name
    githubDeploymentContributor.name
    githubDeploymentAcrPush.name
  ]
}
