targetScope = 'resourceGroup'

// Basic ACR that holds the backend + frontend images. Admin user is disabled: the GitHub deploy
// identity pushes with AcrPush and the app identity pulls with AcrPull (both keyless, via RBAC).

@minLength(3)
param namePrefix string
param environmentName string
param location string
param tags object

@minLength(5)
@maxLength(50)
param registryName string

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: registryName
  location: location
  tags: tags
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: false
    publicNetworkAccess: 'Enabled'
    policies: {
      quarantinePolicy: {
        status: 'disabled'
      }
      trustPolicy: {
        type: 'Notary'
        status: 'disabled'
      }
      retentionPolicy: {
        days: 7
        status: 'disabled'
      }
    }
  }
}

output summary object = {
  module: 'container-registry'
  namePrefix: namePrefix
  registryName: registry.name
  registryLoginServer: registry.properties.loginServer
  registryId: registry.id
  environmentName: environmentName
  location: location
}

output registryId string = registry.id
output registryName string = registry.name
output registryLoginServer string = registry.properties.loginServer
