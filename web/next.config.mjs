/** @type {import('next').NextConfig} */
export default {
  // better-sqlite3 is a native module; it must not be bundled for the server.
  serverExternalPackages: ['better-sqlite3'],
};
