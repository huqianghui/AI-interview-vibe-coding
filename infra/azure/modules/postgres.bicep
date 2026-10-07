targetScope = 'resourceGroup'

// Persistent database: Azure Database for PostgreSQL flexible server, private and keyless.
//
// Before this the backend ran SQLite inside the container, with no volume, so every deploy or
// restart started from an empty database: personas, user assignments and every interview record
// were lost (seen 2026-10-07, #187). This server keeps them.
//
// - Network: VNet-integrated in the delegated subnet from network.bicep, private DNS zone linked to
//   the VNet, public network access disabled. Only the Container Apps environment can reach it.
// - Auth: Microsoft Entra only (password login disabled). The backend's user-assigned managed
//   identity is the Entra administrator, so the app (which also runs the migrations at boot) logs
//   in with a token for that identity (app/db.py, DATABASE_AUTH=entra). No password exists.

param namePrefix string
param environmentName string
param location string
param tags object

@description('Delegated subnet for the server (network.bicep pgSubnetId).')
param delegatedSubnetId string

@description('Private DNS zone *.private.postgres.database.azure.com (network.bicep pgDnsZoneId).')
param privateDnsZoneId string

@description('Name of the backend managed identity: it becomes the Entra admin and the DB login.')
param backendIdentityName string

@description('Object (principal) id of the backend managed identity.')
param backendIdentityPrincipalId string

@description('Compute SKU. Burstable B1ms is enough for this app (one backend replica).')
param skuName string = 'Standard_B1ms'

param storageSizeGB int = 32

var serverName = 'psql-${namePrefix}-${environmentName}'
var databaseName = 'ai_interview'

resource server 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: serverName
  location: location
  tags: tags
  sku: {
    name: skuName
    tier: 'Burstable'
  }
  properties: {
    version: '16'
    storage: {
      storageSizeGB: storageSizeGB
      autoGrow: 'Enabled'
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
    network: {
      delegatedSubnetResourceId: delegatedSubnetId
      privateDnsZoneArmResourceId: privateDnsZoneId
      publicNetworkAccess: 'Disabled'
    }
    authConfig: {
      activeDirectoryAuth: 'Enabled'
      passwordAuth: 'Disabled'
      tenantId: subscription().tenantId
    }
  }
}

resource entraAdmin 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2024-08-01' = {
  parent: server
  name: backendIdentityPrincipalId
  properties: {
    principalName: backendIdentityName
    principalType: 'ServicePrincipal'
    tenantId: subscription().tenantId
  }
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: server
  name: databaseName
  dependsOn: [
    entraAdmin
  ]
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

output serverName string = server.name
output serverFqdn string = server.properties.fullyQualifiedDomainName
output databaseName string = databaseName
// What the backend's DATABASE_URL should be: the Entra login is the identity's name, no password.
output databaseUrl string = 'postgresql+asyncpg://${backendIdentityName}@${server.properties.fullyQualifiedDomainName}:5432/${databaseName}'
