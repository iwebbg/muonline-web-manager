/** Fixed main-owned identities; renderer input and saved preferences cannot select WSL. */
export const productionProfile = Object.freeze({ development: false, distribution: 'Ubuntu-24.04', taskName: 'MuOnline-Web-WSL' });
export const developmentProfile = Object.freeze({ development: true, distribution: 'MuOnline-Dev', taskName: 'MuOnline-Web-Dev-WSL' });

export function runtimeProfile(packaged, development) {
  if (packaged && development) {
    throw new Error('The development WSL profile is available only from source.');
  }
  return development ? developmentProfile : productionProfile;
}

/** Match the complete distribution name, including when other similarly named distros exist. */
export function isWsl2Distribution(output, distribution) {
  return output.replaceAll('\u0000', '').split(/\r?\n/).some(line => {
    const columns = line.trim().replace(/^\*\s*/, '').split(/\s+/);
    return columns[0] === distribution && columns.at(-1) === '2';
  });
}
