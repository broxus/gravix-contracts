

async function main() {
    const data = await locklift.factory.getContractArtifacts('GravixVault');
    const buf = Buffer.from(data.code, 'base64'); // Ta-da
    console.log(buf.length);
}

main()
  .then(() => process.exit(0))
  .catch(e => {
    console.log(e);
    process.exit(1);
  });
