targetScope = 'resourceGroup'

// Storage account with three private blob containers:
//   - client-bundle : the gitignored client interview material (importer + source docs, zipped),
//                     uploaded once and pulled at container boot by fetch_client_bundle.py (MI auth).
//   - materials     : the durable store for SOP originals (DEFAULT_STORAGE_PROVIDER=azure). The
//                     Container App's own disk is thrown away on every new revision, so SOP bytes
//                     kept there were lost while PostgreSQL kept their rows (every citation 404'd).
//   - recordings    : candidate voice recordings (the microphone only, one WAV per question). A
//                     lifecycle rule deletes each one `recordingRetentionDays` after it was written.
// Public blob access is off. The backend MI reads everything via Storage Blob Data Reader (RBAC,
// keyless, role-assignments.bicep) and WRITES only to `materials` and `recordings` (Contributor
// scoped to each container, below), so it still cannot touch the client bundle.
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
param recordingsContainerName string = 'recordings'

@description('Days a candidate recording is kept before the lifecycle rule deletes it.')
param recordingRetentionDays int = 90

@description('Backend managed identity granted write access to the materials container only.')
param backendIdentityPrincipalId string = ''

var storageBlobDataContributorRoleDefinitionId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')

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

resource backendMaterialsWriter 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(backendIdentityPrincipalId)) {
  name: guid(materialsContainer.id, backendIdentityPrincipalId, 'storage-blob-data-contributor')
  scope: materialsContainer
  properties: {
    principalId: backendIdentityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: storageBlobDataContributorRoleDefinitionId
  }
}

resource recordingsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: recordingsContainerName
  properties: {
    publicAccess: 'None'
  }
}

resource backendRecordingsWriter 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(backendIdentityPrincipalId)) {
  name: guid(recordingsContainer.id, backendIdentityPrincipalId, 'storage-blob-data-contributor')
  scope: recordingsContainer
  properties: {
    principalId: backendIdentityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: storageBlobDataContributorRoleDefinitionId
  }
}

// Recordings are personal data: deleted automatically, whatever the app does.
resource lifecycle 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  parent: storageAccount
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          name: 'delete-recordings'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: {
              blobTypes: [ 'blockBlob' ]
              prefixMatch: [ '${recordingsContainerName}/' ]
            }
            actions: {
              baseBlob: {
                delete: {
                  daysAfterCreationGreaterThan: recordingRetentionDays
                }
              }
            }
          }
        }
      ]
    }
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
    recordingsContainer.name
  ]
  environmentName: environmentName
  location: location
}

output storageAccountName string = storageAccount.name
output storageAccountId string = storageAccount.id
output blobEndpoint string = storageAccount.properties.primaryEndpoints.blob
output clientBundleContainerName string = clientBundleContainer.name
