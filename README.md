# event-relay


## Scope

### Responsible for

1. **Sources:** being the only part that deals with event sources.
2. **Normalizing:** turning every source's events into the shape set by the event contract.
3. **Subscriptions:** letting subscribers choose which events they want, and change or cancel
   that choice.
4. **Notifying:** delivering each event to the subscribers.
5. **Rate Limiting:** define how often the subscribers can be notified.
