#!/usr/bin/env bash
# Grant the AI-interview backend managed identity access to the EXISTING Azure AI Foundry account.
#
# The infra Bicep intentionally does NOT create any AI resource — it reuses the Foundry / Voice Live
# account that already exists (in Sweden Central). Because that account lives OUTSIDE this
# deployment's resource group, its RBAC cannot be expressed in the RG-scoped Bicep. This one-time,
# idempotent script closes the gap: it grants the backend user-assigned MI the roles it needs to
# call Foundry Agents + Voice Live via DefaultAzureCredential (keyless — the Foundry resource has
# API-key auth disabled, so Entra/MI is the ONLY working path).
#
# Roles granted on the Foundry account scope:
#   Cognitive Services User  — call the account's data plane (Voice Live / model inference).
#   Azure AI Developer       — use Foundry projects/agents (interviewer-agent sync, F5).
#
# If the interview uses a Foundry IQ knowledge base (SOP citations via AI Search), also run the
# Search RBAC chain — see the reference grant-search-rbac.sh; not included here by default.
#
# Prerequisites:
#   - az login  (an account with Owner or User Access Administrator on the Foundry account)
#   - The infra deployment has run (so the backend MI exists).
#
# Usage:
#   ./grant-foundry-rbac.sh \
#       --mi-principal-id <backendIdentityPrincipalId-from-bicep-output> \
#       --foundry-subscription <sub-id> \
#       --foundry-rg <foundry-resource-group> \
#       --foundry-account <foundry-account-name>
#
# All four values can also be supplied via env vars MI_PRINCIPAL_ID, FOUNDRY_SUBSCRIPTION,
# FOUNDRY_RG, FOUNDRY_ACCOUNT.

set -euo pipefail

MI_PRINCIPAL_ID="${MI_PRINCIPAL_ID:-}"
FOUNDRY_SUBSCRIPTION="${FOUNDRY_SUBSCRIPTION:-}"
FOUNDRY_RG="${FOUNDRY_RG:-}"
FOUNDRY_ACCOUNT="${FOUNDRY_ACCOUNT:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mi-principal-id) MI_PRINCIPAL_ID="$2"; shift 2 ;;
    --foundry-subscription) FOUNDRY_SUBSCRIPTION="$2"; shift 2 ;;
    --foundry-rg) FOUNDRY_RG="$2"; shift 2 ;;
    --foundry-account) FOUNDRY_ACCOUNT="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

for var in MI_PRINCIPAL_ID FOUNDRY_SUBSCRIPTION FOUNDRY_RG FOUNDRY_ACCOUNT; do
  if [[ -z "${!var}" ]]; then
    echo "ERROR: $var is required (flag or env var). See usage in the script header." >&2
    exit 2
  fi
done

FOUNDRY_SCOPE="/subscriptions/${FOUNDRY_SUBSCRIPTION}/resourceGroups/${FOUNDRY_RG}/providers/Microsoft.CognitiveServices/accounts/${FOUNDRY_ACCOUNT}"

for ROLE in "Cognitive Services User" "Azure AI Developer"; do
  echo "==> Ensuring role '${ROLE}' for ${MI_PRINCIPAL_ID} on ${FOUNDRY_ACCOUNT}..."
  EXISTING=$(az role assignment list --scope "${FOUNDRY_SCOPE}" \
    --query "[?principalId=='${MI_PRINCIPAL_ID}' && roleDefinitionName=='${ROLE}'] | length(@)" -o tsv)
  if [[ "${EXISTING}" != "0" ]]; then
    echo "    already assigned — skipping"
  else
    az role assignment create \
      --assignee-object-id "${MI_PRINCIPAL_ID}" \
      --assignee-principal-type ServicePrincipal \
      --role "${ROLE}" \
      --scope "${FOUNDRY_SCOPE}" \
      --query "id" -o tsv
    echo "    created"
  fi
done

echo ""
echo "Done. RBAC propagation can take 5-10 minutes before the backend can call Foundry/Voice Live."
