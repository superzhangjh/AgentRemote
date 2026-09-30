// Binary file extensions (images are handled by ImageViewer, not here)
const BINARY_EXTENSIONS = [
  // Archives
  'zip', 'tar', 'gz', 'rar', '7z', 'bz2', 'xz', 'tgz', 'zst',
  // Executables / installers / packages
  'exe', 'dll', 'so', 'dylib', 'app', 'dmg', 'msi', 'apk', 'aab', 'apks',
  'xapk', 'ipa', 'deb', 'rpm', 'pkg', 'snap', 'wasm',
  // Media
  'mp3', 'mp4', 'wav', 'avi', 'mov', 'mkv', 'flv', 'wmv', 'm4a', 'ogg',
  // Documents
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp',
  // Fonts
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  // Database
  'db', 'sqlite', 'sqlite3',
  // Other binary
  'bin', 'dat', 'iso', 'img', 'class', 'jar', 'war', 'pyc', 'pyo'
];

export const isBinaryFile = (filename: string): boolean => {
  const ext = filename.split('.').pop()?.toLowerCase();
  return BINARY_EXTENSIONS.includes(ext ?? '');
};
