targetScope = 'resourceGroup'

// User-assigned identity federated to GitHub Actions OIDC, so the deploy workflow logs in to Azure
// keylessly (no stored service-principal secret). It gets Contributor + AcrPush via role-assignments.

param namePrefix string
param environmentName string
param location string
param tags object

param githubOwner string
param githubRepo string

@description('Branches allowed to deploy through OIDC. One federated credential is created per branch (main is the steady-state deploy branch; a feature branch can be added for a first from-branch deploy).')
param githubBranches array
param githubEnvironmentName string = ''

// Some GitHub orgs/repos present the OIDC subject in *immutable-ID* form
// (repo:<owner>@<ownerId>/<repo>@<repoId>:ref:...) instead of the plain
// repo:<owner>/<repo>:ref:... form. Azure matches the subject exactly, so when the immutable form
// is presented, supply the owner/repo numeric IDs here to also create a matching credential per
// branch. Leave empty to create only the plain-text credentials. (Look up IDs with
// `gh api /repos/<owner>/<repo> --jq '{owner: .owner.id, repo: .id}'`.)
param githubOwnerId string = ''
param githubRepoId string = ''

var identityName = 'id-${namePrefix}-${environmentName}-github-deploy'
var hasImmutableIds = !empty(githubOwnerId) && !empty(githubRepoId)
var environmentCredentialName = 'github-env-${githubEnvironmentName}'
var environmentSubject = 'repo:${githubOwner}/${githubRepo}:environment:${githubEnvironmentName}'

resource githubDeploymentIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: identityName
  location: location
  tags: tags
}

// One plain-text federated credential per branch. @batchSize(1) serializes the writes because
// federated-credential writes to a single identity must not run concurrently (409 otherwise).
// A federated-credential *resource name* cannot contain '/', but branch names can (e.g.
// "feat/azure-cicd-deploy"). Sanitize the name only; the OIDC *subject* keeps the real branch.
@batchSize(1)
resource githubFederatedCredential 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = [
  for branch in githubBranches: {
    parent: githubDeploymentIdentity
    name: 'github-${replace(branch, '/', '-')}'
    properties: {
      issuer: 'https://token.actions.githubusercontent.com'
      subject: 'repo:${githubOwner}/${githubRepo}:ref:refs/heads/${branch}'
      audiences: [
        'api://AzureADTokenExchange'
      ]
    }
  }
]

// One immutable-ID federated credential per branch (only when the numeric IDs are supplied).
@batchSize(1)
resource githubImmutableFederatedCredential 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = [
  for branch in (hasImmutableIds ? githubBranches : []): {
    parent: githubDeploymentIdentity
    name: 'github-immutable-${replace(branch, '/', '-')}'
    // Chain after the plain credentials so no two FIC writes to this identity overlap.
    dependsOn: [
      githubFederatedCredential
    ]
    properties: {
      issuer: 'https://token.actions.githubusercontent.com'
      subject: 'repo:${githubOwner}@${githubOwnerId}/${githubRepo}@${githubRepoId}:ref:refs/heads/${branch}'
      audiences: [
        'api://AzureADTokenExchange'
      ]
    }
  }
]

resource githubEnvironmentFederatedCredential 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = if (!empty(githubEnvironmentName)) {
  parent: githubDeploymentIdentity
  name: environmentCredentialName
  // Federated-credential writes to one identity must be serialized (concurrent writes 409). Chain
  // off the immutable credentials (and, transitively, the plain ones).
  dependsOn: [
    githubFederatedCredential
    githubImmutableFederatedCredential
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
  branches: githubBranches
  environmentFederatedCredentialName: !empty(githubEnvironmentName) ? githubEnvironmentFederatedCredential.name : ''
  environmentSubject: !empty(githubEnvironmentName) ? environmentSubject : ''
  environmentName: environmentName
  location: location
}

output githubDeploymentIdentityId string = githubDeploymentIdentity.id
output githubDeploymentClientId string = githubDeploymentIdentity.properties.clientId
output githubDeploymentPrincipalId string = githubDeploymentIdentity.properties.principalId
