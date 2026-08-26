targetScope = 'resourceGroup'

// User-assigned identity federated to GitHub Actions OIDC, so the deploy workflow logs in to Azure
// keylessly (no stored service-principal secret). It gets Contributor + AcrPush via role-assignments.

param namePrefix string
param environmentName string
param location string
param tags object

param githubOwner string
param githubRepo string
param githubBranch string
param githubEnvironmentName string = ''

var identityName = 'id-${namePrefix}-${environmentName}-github-deploy'
// A federated-credential *resource name* cannot contain '/', but branch names can (e.g.
// "feat/azure-cicd-deploy"). Sanitize the name only; the OIDC *subject* keeps the real branch.
var credentialName = 'github-${replace(githubBranch, '/', '-')}'
var repositorySubject = 'repo:${githubOwner}/${githubRepo}:ref:refs/heads/${githubBranch}'
var environmentCredentialName = 'github-env-${githubEnvironmentName}'
var environmentSubject = 'repo:${githubOwner}/${githubRepo}:environment:${githubEnvironmentName}'

resource githubDeploymentIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: identityName
  location: location
  tags: tags
}

resource githubFederatedCredential 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: githubDeploymentIdentity
  name: credentialName
  properties: {
    issuer: 'https://token.actions.githubusercontent.com'
    subject: repositorySubject
    audiences: [
      'api://AzureADTokenExchange'
    ]
  }
}

resource githubEnvironmentFederatedCredential 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = if (!empty(githubEnvironmentName)) {
  parent: githubDeploymentIdentity
  name: environmentCredentialName
  dependsOn: [
    githubFederatedCredential
  ]
  properties: {
    issuer: 'https://token.actions.githubusercontent.com'
    subject: environmentSubject
    audiences: [
      'api://AzureADTokenExchange'
    ]
  }
}

output summary object = {
  module: 'github-oidc'
  identityName: githubDeploymentIdentity.name
  clientId: githubDeploymentIdentity.properties.clientId
  principalId: githubDeploymentIdentity.properties.principalId
  federatedCredentialName: githubFederatedCredential.name
  environmentFederatedCredentialName: !empty(githubEnvironmentName) ? githubEnvironmentFederatedCredential.name : ''
  subject: repositorySubject
  environmentSubject: !empty(githubEnvironmentName) ? environmentSubject : ''
  environmentName: environmentName
  location: location
}

output githubDeploymentIdentityId string = githubDeploymentIdentity.id
output githubDeploymentClientId string = githubDeploymentIdentity.properties.clientId
output githubDeploymentPrincipalId string = githubDeploymentIdentity.properties.principalId
