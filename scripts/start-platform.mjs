// Compatibility entry: ordinary startup never provisions or migrates.
import {startupMain} from './existing-platform-startup.mjs';
await startupMain();
