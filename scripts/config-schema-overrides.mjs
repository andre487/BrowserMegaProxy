// Local browser contract additions until they are published upstream.
export function dynamicSubscriptionSchema(schema) {
  const subscriptions = schema.$defs.browserSubscriptions.properties
  for (const field of ['domainSources', 'siteSources']) {
    subscriptions[field].items = { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,63}$' }
    subscriptions[field].maxItems = 64
  }
  schema.$defs.browserRouting.properties.strategy = {
    type: 'string',
    enum: ['manual', 'lists', 'profiles', 'tabs', 'failover']
  }
  schema.$defs.proxy.properties.type.enum.push('MASQUE')
  schema.$defs.browserProfile.properties.masqueTemplate = { type: 'string', maxLength: 2048 }
  return schema
}
