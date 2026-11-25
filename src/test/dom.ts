// Gives a frontend test file a DOM (happy-dom). Import it first, before React
// or Testing Library, which check for a DOM when they load.
//
// It replaces browser-like globals (Event, EventTarget, fetch, …) for the whole
// process, so `npm test` runs the frontend tests in their own Bun process,
// apart from the server tests.
import { GlobalRegistrator } from '@happy-dom/global-registrator'

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register({ url: 'http://localhost/' })

// Tell React this is a test environment, so act() works without warnings.
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
