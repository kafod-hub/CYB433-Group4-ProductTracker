const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying contracts with account:", deployer.address);

  const Tracker = await hre.ethers.getContractFactory("ProductAuthenticityTracker");
  const tracker = await Tracker.deploy(deployer.address);
  await tracker.waitForDeployment();

  const contractAddress = await tracker.getAddress();
  const deployTx = tracker.deploymentTransaction();

  console.log("ProductAuthenticityTracker deployed to:", contractAddress);
  console.log("Deployment Transaction Hash:", deployTx.hash);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});