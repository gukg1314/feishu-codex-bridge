export function shouldShowOnStartup(platform: NodeJS.Platform, wasOpenedAtLogin: boolean): boolean {
  return platform === 'win32' && !wasOpenedAtLogin;
}
