targetScope = 'resourceGroup'

// Storage account with two private blob containers:
//   - client-bundle : the gitignored client interview material (importer + source docs, zipped),
//                     uploaded once and pulled at container boot by fetch_client_bundle.py (MI auth).
//   - materials     : optional durable store for SOP uploads if MATERIAL_STORAGE_PATH is pointed at
//                     blob rather than the ephemeral local disk (kept for future use).
// Public blob access is off; the backend MI reads via Storage Blob Data Reader (RBAC, keyless).
//
// Reachability: the account is fully private. The MCAPS management-group policy
// StorageAccount_PublicNetwork_Modify force-disables publicNetworkAccess regardless of what this
// template asks for, so what actually makes the blob reachable from the backend is the PRIVATE
// ENDPOINT + private DNS zone created in network.bicep (targeting this account's `blob` sub-resource)
// — NOT any field on this account. Flipping publicNetworkAccess here would have no effect.

@minLength(3)
param namePrefix string
param environmentName string
param location string
param tags object

@minLength(3)
@maxLength(24)
param storageAccountName string

param clientBundleContainerName string = 'client-bundle'
param materialsContainerName string = 'materials'

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  tags: tags
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    // Keyless by design: the app reads via managed identity (Storage Blob Data Reader). Shared-key
    // access is disabled to force AAD auth and keep account keys out of the deployment.
    allowSharedKeyAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    // Aspirational only — the Modify policy forces this to Disabled live (see the header note).
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      bypass: 'AzureServices'
      // Deny by default: the account is reached only via the blob private endpoint (network.bicep).
      defaultAction: 'Deny'
    }
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storageAccount
  name: 'default'
  properties: {
    deleteRetentionPolicy: {
      enabled: true
      days: 7
    }
    containerDeleteRetentionPolicy: {
      enabled: true
      days: 7
    }
  }
}

resource clientBundleContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: clientBundleContainerName
  properties: {
    publicAccess: 'None'
  }
}

resource materialsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: materialsContainerName
  properties: {
    publicAccess: 'None'
  }
}

output summary object = {
  module: 'storage'
  namePrefix: namePrefix
  storageAccountName: storageAccount.name
  storageAccountId: storageAccount.id
  blobEndpoint: storageAccount.properties.primaryEndpoints.blob
  containers: [
    clientBundleContainer.name
    materialsContainer.name
  ]
  environmentName: environmentName
  location: location
}

output storageAccountName string = storageAccount.name
output storageAccountId string = storageAccount.id
output blobEndpoint string = storageAccount.properties.primaryEndpoints.blob
output clientBundleContainerName string = clientBundleContainer.name
