targetScope = 'resourceGroup'

// The "Voice performance" Azure Workbook over the App Insights resource: connection setup, the
// avatar WebRTC handshake (ICE / STUN / TURN / SDP / first frame), every turn's stages, and the
// backend business spans. The content is workbooks/voice-performance.json; the browser events it
// reads are defined in frontend/src/telemetry/voiceTimeline.ts.
//
// Called from monitoring.bicep. It is also deployable on its own, against an existing App Insights
// resource, when a full main.bicep re-apply is not an option:
//   az deployment group create -g <rg> -f modules/voice-workbook.bicep -p appInsightsName=<appi>

param appInsightsName string
param location string = resourceGroup().location
param tags object = {}

resource appInsights 'Microsoft.Insights/components@2020-02-02' existing = {
  name: appInsightsName
}

resource workbook 'Microsoft.Insights/workbooks@2023-06-01' = {
  // A workbook's name must be a GUID; derived, so a re-apply updates the same workbook.
  name: guid(appInsights.id, 'voice-performance')
  location: location
  tags: tags
  kind: 'shared'
  properties: {
    displayName: 'AI Interview — Voice performance'
    category: 'workbook'
    sourceId: appInsights.id
    serializedData: loadTextContent('../workbooks/voice-performance.json')
  }
}

output workbookId string = workbook.id
