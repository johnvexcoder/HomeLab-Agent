import path from 'node:path';

let hostRootPath = '/';

export function setHostRootPath(root: string) {
  // Ensure the root path has no trailing slash, unless it's just '/'
  hostRootPath = (root?.replace(/\/+$/, '') || '/') === '' ? '/' : root; 
}

/**
 * Returns the path mapped into the container's host root if running in a container,
 * or the absolute path on a normal system.
 * Usage: hostPath('/proc/stat')
 */
export function hostPath(p: string): string {
  if (hostRootPath === '/') return p;
  
  // Cleanly join root and the absolute path without double slashes
  return path.join(hostRootPath, p);
}
