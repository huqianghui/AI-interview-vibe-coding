targetScope = 'resourceGroup'

// VNet + Storage private endpoint — the network path that revives boot-time client-bank seeding.
//
// The storage account is policy-locked private: the MCAPS management-group policy
// StorageAccount_PublicNetwork_Modify (effect Modify) force-disables publicNetworkAccess, so a
// VNet-less Container App can never reach the blob at boot (this is why entrypoint.sh's
// fetch->import channel was dead). This module opens a PRIVATE path instead:
//
//   1. a VNet with a subnet delegated to Microsoft.App/environments (the ACA env integrates here),
//   2. a private endpoint on the storage account's blob service, and
//   3. a privatelink.blob.core.windows.net private DNS zone linked to the VNet, so the backend MI's
//      https://<account>.blob.core.windows.net calls resolve to the PE's private IP from inside the
//      environment — no app/code change; the same public-looking hostname now routes privately.
//
// Consumed by container-apps.bicep (infrastructureSubnetId) and storage.bicep (storageAccountId in).

param namePrefix string
param environmentName string
param location string
param tags object

@description('Resource id of the storage account the blob private endpoint targets (from storage.bicep).')
param storageAccountId string

@description('Name of that storage account (used for private-endpoint / connection naming).')
param storageAccountName string

var vnetName = 'vnet-${namePrefix}-${environmentName}'
var infraSubnetName = 'snet-${namePrefix}-${environmentName}-infra'
var peSubnetName = 'snet-${namePrefix}-${environmentName}-pe'
var blobDnsZoneName = 'privatelink.blob.${environment().suffixes.storage}'
var blobPeName = 'pe-${namePrefix}-${environmentName}-blob'

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: vnetName
  location: location
  tags: tags
  properties: {
    addressSpace: {
      addressPrefixes: [
        '10.10.0.0/16'
      ]
    }
    subnets: [
      {
        // Infrastructure subnet for the Container Apps managed environment. Must be delegated to
        // Microsoft.App/environments; /23 is safe for both Consumption and workload-profile envs.
        name: infraSubnetName
        properties: {
          addressPrefix: '10.10.0.0/23'
          delegations: [
            {
              name: 'Microsoft.App.environments'
              properties: {
                serviceName: 'Microsoft.App/environments'
              }
            }
          ]
        }
      }
      {
        // Private-endpoint subnet. NOT delegated; network policies disabled so the PE NIC can bind.
        name: peSubnetName
        properties: {
          addressPrefix: '10.10.2.0/27'
          privateEndpointNetworkPolicies: 'Disabled'
        }
      }
    ]
  }
}

resource infraSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' existing = {
  parent: vnet
  name: infraSubnetName
}

resource peSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' existing = {
  parent: vnet
  name: peSubnetName
}

resource blobDnsZone 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: blobDnsZoneName
  location: 'global'
  tags: tags
}

resource blobDnsZoneLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: blobDnsZone
  name: 'link-${vnetName}'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnet.id
    }
  }
}

resource blobPrivateEndpoint 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: blobPeName
  location: location
  tags: tags
  properties: {
    subnet: {
      id: peSubnet.id
    }
    privateLinkServiceConnections: [
      {
        name: '${storageAccountName}-blob'
        properties: {
          privateLinkServiceId: storageAccountId
          groupIds: [
            'blob'
          ]
        }
      }
    ]
  }
}

// Registers the account's A record in the private zone so <account>.blob.<suffix> resolves privately.
resource blobPeDnsZoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: blobPrivateEndpoint
  name: 'blob-dns-zone-group'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'privatelink-blob-core-windows-net'
        properties: {
          privateDnsZoneId: blobDnsZone.id
        }
      }
    ]
  }
}

output vnetId string = vnet.id
output infrastructureSubnetId string = infraSubnet.id
output peSubnetId string = peSubnet.id
