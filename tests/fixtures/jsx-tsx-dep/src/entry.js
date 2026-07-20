// The entry itself is plain ESM (no JSX), so it parses even without --jsx. That isolates the
// behaviour under test to the .tsx DEPENDENCY: a package whose React Native entry is a .tsx source
// file (the react-native-safe-area-context shape), reachable but only carryable under --jsx.
import { SafeArea } from 'safe-area-like'

export const App = SafeArea
