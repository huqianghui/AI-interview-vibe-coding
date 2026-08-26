targetScope = 'resourceGroup'

// Log Analytics workspace + Application Insights. The workspace backs the Container Apps managed
// environment's log sink; the App Insights connection string is injected into the backend so its
// OpenTelemetry traces land in the same resource group.

param namePrefix string
param environmentName string
param location string
param tags object

var workspaceName = 'law-${namePrefix}-${environmentName}'
var appInsightsName = 'appi-${namePrefix}-${environmentName}'

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: workspaceName
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
    features: {
      enableLogAccessUsingOnlyResourcePermissions: true
    }
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: appInsightsName
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: workspace.id
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

output summary object = {
  module: 'monitoring'
  logAnalyticsWorkspaceName: workspace.name
  applicationInsightsName: appInsights.name
  applicationInsightsConnectionString: appInsights.properties.ConnectionString
  logAnalyticsWorkspaceId: workspace.id
  environmentName: environmentName
  location: location
}

output logAnalyticsWorkspaceName string = workspace.name
output applicationInsightsConnectionString string = appInsights.properties.ConnectionString
