// Builds the Windows app (desktop/TuringLife): the web page first, zipped and embedded in the .exe,
// then one self-contained .exe at desktop/dist/TuringLifeSetup.exe (it installs itself when run).
// Needs the .NET 8 SDK (https://dotnet.microsoft.com/download) and Windows.
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, rmSync } from 'node:fs';

const run = (cmd) => execSync(cmd, { stdio: 'inherit' });
run('npm run build:client');
const zip = 'desktop/TuringLife/web.zip';
if (existsSync(zip)) rmSync(zip);
run(`powershell -NoProfile -Command "Compress-Archive -Path dist/client/* -DestinationPath ${zip} -Force"`);
run('dotnet publish desktop/TuringLife/TuringLife.csproj -c Release -o desktop/dist');
copyFileSync('desktop/dist/TuringLife.exe', 'desktop/dist/TuringLifeSetup.exe');
console.log('\nBuilt desktop/dist/TuringLifeSetup.exe');
