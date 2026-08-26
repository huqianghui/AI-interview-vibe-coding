targetScope = 'resourceGroup'

// User-assigned managed identity shared by the backend + frontend Container Apps. The backend uses
// it (via AZURE_CLIENT_ID + DefaultAzureCredential) to reach Azure AI Foundry / Voice Live, read
// Key Vault secrets, and pull the private client bundle from blob storage — all keyless.

param namePrefix string
param environmentName string
param location string
param tags object

var identityName = 'id-${namePrefix}-${environmentName}-backend'

resource backendIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: identityName
  location: location
  tags: tags
}

output summary object = {
  module: 'managed-identity'
  backendIdentityName: backendIdentity.name
  backendIdentityId: backendIdentity.id
  backendIdentityClientId: backendIdentity.properties.clientId
  backendIdentityPrincipalId: backendIdentity.properties.principalId
  environmentName: environmentName
  location: location
}

output backendIdentityId string = backendIdentity.id
output backendIdentityName string = backendIdentity.name
output backendIdentityClientId string = backendIdentity.properties.clientId
output backendIdentityPrincipalId string = backendIdentity.properties.principalId
