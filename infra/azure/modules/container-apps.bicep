targetScope = 'resourceGroup'

// Backend + frontend Container Apps on a shared managed environment.
//
// Both run SINGLE-REPLICA (min=max=1): the backend keeps its state in EPHEMERAL SQLite on the
// replica's own disk (reseeded every boot by entrypoint.sh), so a second replica would diverge and
// break Voice Live WebSocket affinity. The frontend nginx reverse-proxies /api to the backend
// (same-origin, no CORS); its BACKEND_URL env is templated into nginx.conf at start.

param namePrefix string
param environmentName string
param location string
param tags object

param logAnalyticsWorkspaceName string
param applicationInsightsConnectionString string
param registryLoginServer string
param backendIdentityId string
param backendIdentityClientId string
param backendImage string
param frontendImage string

// Runtime secrets are delivered as Container App native secrets (encrypted at rest by the platform)
// rather than Key Vault secretRefs: this subscription's Azure Policy force-disables Key Vault public
// network access, which a VNet-less Container App cannot reach. Passed as @secure() params → never
// logged, never in the repo.
@secure()
param secretKey string
@secure()
param encryptionKey string
@secure()
param seedAdminPassword string
@secure()
param adminApiToken string

param storageAccountBlobEndpoint string
param clientBundleContainerName string = 'client-bundle'

// Blob name of the uploaded client bundle zip. Empty → backend boots in public-demo mode (generic
// bank only); set it (e.g. 'rfcsm-bundle.zip') once the bundle is uploaded to seed the client bank.
param clientBundleBlob string = ''

// Existing Azure AI Foundry / Voice Live wiring (the resource itself is NOT created here — it is
// reused; the backend MI is granted access by scripts/grant-foundry-rbac.sh).
param azureFoundryEndpoint string
param foundryProjectEndpoint string
param azureFoundryDefaultProject string = ''
param foundryAgentModel string = 'gpt-4o'
param voiceLiveDefaultModel string = 'gpt-4o'
param voiceLiveApiVersion string = '2026-01-01-preview'

// Ephemeral writable paths inside the container (mirrors the Dockerfile ENV defaults).
var databaseUrl = 'sqlite+aiosqlite:///./data/ai_interview.db'
var materialStoragePath = '/app/data/_sop_storage'

var environmentResourceName = 'cae-${namePrefix}-${environmentName}'
var backendAppName = 'ca-${namePrefix}-${environmentName}-backend'
var frontendAppName = 'ca-${namePrefix}-${environmentName}-frontend'

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: logAnalyticsWorkspaceName
}

resource managedEnvironment 'Microsoft.App/managedEnvironments@2023-05-01' = {
  name: environmentResourceName
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: workspace.properties.customerId
        sharedKey: workspace.listKeys().primarySharedKey
      }
    }
  }
}

resource backendApp 'Microsoft.App/containerApps@2023-05-01' = {
  name: backendAppName
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${backendIdentityId}': {}
    }
  }
  properties: {
    managedEnvironmentId: managedEnvironment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8000
        transport: 'auto'
        allowInsecure: false
        // Single replica → pin sessions so a Voice Live WS stays on the one backend instance.
        stickySessions: {
          affinity: 'sticky'
        }
      }
      registries: [
        {
          server: registryLoginServer
          identity: backendIdentityId
        }
      ]
      secrets: [
        {
          name: 'secret-key'
          value: secretKey
        }
        {
          name: 'encryption-key'
          value: encryptionKey
        }
        {
          name: 'seed-admin-password'
          value: seedAdminPassword
        }
        {
          name: 'admin-api-token'
          value: adminApiToken
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'backend'
          image: backendImage
          env: [
            {
              name: 'DATABASE_URL'
              value: databaseUrl
            }
            {
              name: 'MATERIAL_STORAGE_PATH'
              value: materialStoragePath
            }
            {
              name: 'DEBUG'
              value: 'false'
            }
            {
              name: 'SECRET_KEY'
              secretRef: 'secret-key'
            }
            {
              name: 'ENCRYPTION_KEY'
              secretRef: 'encryption-key'
            }
            {
              name: 'SEED_ADMIN_PASSWORD'
              secretRef: 'seed-admin-password'
            }
            {
              name: 'ADMIN_API_TOKEN'
              secretRef: 'admin-api-token'
            }
            // Fresh boot has no saved DB master config, so pin providers to azure here; the app
            // reaches Foundry / Voice Live via the MI (DefaultAzureCredential + AZURE_CLIENT_ID).
            {
              name: 'DEFAULT_LLM_PROVIDER'
              value: 'azure'
            }
            {
              name: 'DEFAULT_VOICE_PROVIDER'
              value: 'azure'
            }
            {
              name: 'DEFAULT_RETRIEVAL_PROVIDER'
              value: 'azure'
            }
            {
              name: 'DEFAULT_AGENT_SYNC_PROVIDER'
              value: 'azure'
            }
            {
              name: 'AZURE_FOUNDRY_ENDPOINT'
              value: azureFoundryEndpoint
            }
            {
              name: 'FOUNDRY_PROJECT_ENDPOINT'
              value: foundryProjectEndpoint
            }
            {
              name: 'AZURE_FOUNDRY_DEFAULT_PROJECT'
              value: azureFoundryDefaultProject
            }
            {
              name: 'FOUNDRY_AGENT_MODEL'
              value: foundryAgentModel
            }
            {
              name: 'VOICE_LIVE_DEFAULT_MODEL'
              value: voiceLiveDefaultModel
            }
            {
              name: 'VOICE_LIVE_API_VERSION'
              value: voiceLiveApiVersion
            }
            // Selects the user-assigned MI for DefaultAzureCredential (the app has one identity but
            // this is required to disambiguate from any system-assigned identity).
            {
              name: 'AZURE_CLIENT_ID'
              value: backendIdentityClientId
            }
            // Client-bundle fetch (entrypoint.sh). Empty CLIENT_BUNDLE_BLOB → public-demo mode.
            {
              name: 'AZURE_STORAGE_ACCOUNT_URL'
              value: storageAccountBlobEndpoint
            }
            {
              name: 'CLIENT_BUNDLE_CONTAINER'
              value: clientBundleContainerName
            }
            {
              name: 'CLIENT_BUNDLE_BLOB'
              value: clientBundleBlob
            }
            {
              name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
              value: applicationInsightsConnectionString
            }
          ]
          resources: {
            cpu: json('1.0')
            memory: '2Gi'
          }
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
    }
  }
}

resource frontendApp 'Microsoft.App/containerApps@2023-05-01' = {
  name: frontendAppName
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${backendIdentityId}': {}
    }
  }
  properties: {
    managedEnvironmentId: managedEnvironment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8080
        transport: 'auto'
        allowInsecure: false
      }
      registries: [
        {
          server: registryLoginServer
          identity: backendIdentityId
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'frontend'
          image: frontendImage
          env: [
            {
              name: 'BACKEND_URL'
              value: 'https://${backendApp.properties.configuration.ingress.fqdn}'
            }
          ]
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
    }
  }
}

output summary object = {
  module: 'container-apps'
  environmentName: environmentName
  managedEnvironmentName: managedEnvironment.name
  backendAppName: backendApp.name
  backendUrl: 'https://${backendApp.properties.configuration.ingress.fqdn}'
  frontendAppName: frontendApp.name
  frontendUrl: 'https://${frontendApp.properties.configuration.ingress.fqdn}'
  registryLoginServer: registryLoginServer
  location: location
}

output backendUrl string = 'https://${backendApp.properties.configuration.ingress.fqdn}'
output frontendUrl string = 'https://${frontendApp.properties.configuration.ingress.fqdn}'
output backendAppName string = backendApp.name
output frontendAppName string = frontendApp.name
