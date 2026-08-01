import { fixtureValue } from "fixture-dependency"
export function createHostedApplication() { return { contractVersion: 1, async status() { return { state: "ready", message: fixtureValue } } } }
