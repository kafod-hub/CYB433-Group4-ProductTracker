const hre = require("hardhat");

async function main() {
  const CONTRACT_ADDRESS = "0x18519E397A76e90ad715ca1E00639d40E946876F";
  const [admin] = await hre.ethers.getSigners();
  const tracker = await hre.ethers.getContractAt("ProductAuthenticityTracker", CONTRACT_ADDRESS);

  const MANUFACTURER_ROLE = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("MANUFACTURER_ROLE"));
  const serialHash = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("LUXURY-WATCH-2026-001"));

  console.log("1. Granting MANUFACTURER_ROLE...");
  const tx1 = await tracker.grantRole(MANUFACTURER_ROLE, admin.address);
  await tx1.wait();
  console.log("Tx 1 Hash:", tx1.hash);

  console.log("2. Registering product...");
  const tx2 = await tracker.registerProduct(serialHash, "ipfs://QmSepoliaLiveProduct001");
  await tx2.wait();
  console.log("Tx 2 Hash:", tx2.hash);

  const receiverAddress = "0x000000000000000000000000000000000000dEaD";
  console.log("3. Initiating transfer...");
  const tx3 = await tracker.initiateTransfer(serialHash, receiverAddress);
  await tx3.wait();
  console.log("Tx 3 Hash:", tx3.hash);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});