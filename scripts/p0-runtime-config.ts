export interface P0RuntimePasswords {
  app: string;
  authority: string;
  worker: string;
}

export interface P0RuntimeDatabaseUrls {
  app: string;
  authority: string;
  worker: string;
}

export function buildP0RuntimeDatabaseUrls(
  ownerDatabaseUrl: string,
  passwords: P0RuntimePasswords,
): P0RuntimeDatabaseUrls {
  const createUrl = (username: string, password: string): string => {
    const url = new URL(ownerDatabaseUrl);
    url.username = username;
    url.password = password;
    return url.toString();
  };

  return {
    app: createUrl('commander_app', passwords.app),
    authority: createUrl('commander_tenant_authority', passwords.authority),
    worker: createUrl('commander_worker', passwords.worker),
  };
}
