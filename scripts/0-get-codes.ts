const main = async () => {
  const vault = await locklift.factory.getContractArtifacts('GravixVault');
  console.log('Vault\n', vault.code);

  const acc = await locklift.factory.getContractArtifacts('GravixAccount');
  console.log('\nAccount\n', acc.code);

  const oracle = await locklift.factory.getContractArtifacts('OracleProxy');
  console.log('\nOracle\n', oracle.code);
};

main()
  .then(() => process.exit(0))
  .catch(e => {
    console.log(e);
    process.exit(1);
  });
