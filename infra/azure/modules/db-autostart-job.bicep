targetScope = 'resourceGroup'

// Starts the PostgreSQL server whenever it is stopped: an Azure Container Apps scheduled job,
// every 5 minutes, running backend/scripts/db_autostart.py from the backend image with the backend's
// managed identity. Why: the subscription's governance automation stops the server every night
// (16:05 UTC, an identity outside this directory), and a GitHub-scheduled keepalive is best effort
// (it went 12+ hours without running). Azure's own scheduler is reliable; who stops the server does
// not matter.
//
// The identity gets a custom role on the server ONLY: read it and start it — not stop, not modify.
// (On the live public environment the role and the job were first created with the az CLI on
// 2026-10-09, under the same names; see docs/database.md.)
//
// It also gets a custom role on the job ONLY: read, write and start it. Azure now requires
// jobs/write as well as jobs/start/action to start a job with container or init-container overrides
// (owner decision 2026-10-29, after Azure's notice). Nothing starts this job by hand today; it runs on
// its schedule, which is unaffected. (Live role and assignment first created with the az CLI on
// 2026-10-29, under the same name.)

param namePrefix string
param environmentName string
param location string
param tags object
param backendIdentityId string
param backendIdentityClientId string
param backendIdentityPrincipalId string
param registryLoginServer string
@description('Backend image; empty keeps the job\'s current image (the deploy workflow updates it).')
param backendImage string = ''
param postgresServerName string

// Container Apps job names are limited to 31 characters ('caj-aiinterview-public-db-autostart' is 35).
var jobName = 'caj-${namePrefix}-dbstart'

resource managedEnvironment 'Microsoft.App/managedEnvironments@2023-05-01' existing = {
  name: 'cae-${namePrefix}-${environmentName}'
}

resource server 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' existing = {
  name: postgresServerName
}

resource jobCurrent 'Microsoft.App/jobs@2024-03-01' existing = {
  name: jobName
}

var currentImage = jobCurrent.?properties.?template.?containers[0].?image ?? ''
var effectiveImage = !empty(backendImage) ? backendImage : currentImage

resource starterRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(resourceGroup().id, 'postgres-starter')
  properties: {
    roleName: 'AI Interview PostgreSQL Starter'
    description: 'Read a PostgreSQL flexible server and start it. Nothing else.'
    type: 'CustomRole'
    assignableScopes: [ resourceGroup().id ]
    permissions: [
      {
        actions: [
          'Microsoft.DBforPostgreSQL/flexibleServers/read'
          'Microsoft.DBforPostgreSQL/flexibleServers/start/action'
        ]
        notActions: []
      }
    ]
  }
}

resource starterAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(server.id, backendIdentityPrincipalId, 'postgres-starter')
  scope: server
  properties: {
    principalId: backendIdentityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: starterRole.id
  }
}

resource job 'Microsoft.App/jobs@2024-03-01' = {
  name: jobName
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${backendIdentityId}': {} }
  }
  properties: {
    environmentId: managedEnvironment.id
    configuration: {
      triggerType: 'Schedule'
      scheduleTriggerConfig: {
        cronExpression: '*/5 * * * *'
        parallelism: 1
        replicaCompletionCount: 1
      }
      replicaTimeout: 900
      replicaRetryLimit: 0
      registries: [
        { server: registryLoginServer, identity: backendIdentityId }
      ]
    }
    template: {
      containers: [
        {
          name: 'db-autostart'
          image: effectiveImage
          command: [ 'python', 'scripts/db_autostart.py' ]
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          env: [
            { name: 'AZURE_SUBSCRIPTION_ID', value: subscription().subscriptionId }
            { name: 'POSTGRES_RESOURCE_GROUP', value: resourceGroup().name }
            { name: 'POSTGRES_SERVER_NAME', value: postgresServerName }
            { name: 'AZURE_CLIENT_ID', value: backendIdentityClientId }
          ]
        }
      ]
    }
  }
}

resource jobStarterRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(resourceGroup().id, 'aca-job-start-overrides')
  properties: {
    roleName: 'Container Apps Job Start With Overrides'
    description: 'Start a Container Apps job, including starts with container/initContainer overrides (jobs/write + jobs/start/action).'
    type: 'CustomRole'
    assignableScopes: [ resourceGroup().id ]
    permissions: [
      {
        actions: [
          'Microsoft.App/jobs/read'
          'Microsoft.App/jobs/write'
          'Microsoft.App/jobs/start/action'
        ]
        notActions: []
      }
    ]
  }
}

resource jobStarterAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(job.id, backendIdentityPrincipalId, 'aca-job-start-overrides')
  scope: job
  properties: {
    principalId: backendIdentityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: jobStarterRole.id
  }
}

output jobName string = job.name
