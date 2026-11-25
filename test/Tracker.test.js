const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("ProductAuthenticityTracker", function () {
  let tracker;
  let admin, manufacturer, retailer, buyer, attacker;

  const MANUFACTURER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("MANUFACTURER_ROLE"));
  const RETAILER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("RETAILER_ROLE"));

  const serial1 = ethers.keccak256(ethers.toUtf8Bytes("ROLEX-SN-2026-001"));
  const serial2 = ethers.keccak256(ethers.toUtf8Bytes("ROLEX-SN-2026-002"));
  const cid1 = "ipfs://QmExampleMetadataHash001";

  beforeEach(async function () {
    [admin, manufacturer, retailer, buyer, attacker] = await ethers.getSigners();
    const Tracker = await ethers.getContractFactory("ProductAuthenticityTracker");
    tracker = await Tracker.deploy(admin.address);
    await tracker.waitForDeployment();

    await tracker.connect(admin).grantRole(MANUFACTURER_ROLE, manufacturer.address);
    await tracker.connect(admin).grantRole(RETAILER_ROLE, retailer.address);
  });

  it("1. Should revert deployment if initialAdmin is zero address", async function () {
    const Tracker = await ethers.getContractFactory("ProductAuthenticityTracker");
    await expect(Tracker.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(
      tracker,
      "ZeroAddress"
    );
  });

  it("2. Should allow authorized manufacturer to register a product", async function () {
    await expect(tracker.connect(manufacturer).registerProduct(serial1, cid1))
      .to.emit(tracker, "ProductRegistered")
      .withArgs(serial1, manufacturer.address, cid1);

    const info = await tracker.verifyProduct(serial1);
    expect(info.exists).to.equal(true);
    expect(info.currentOwner).to.equal(manufacturer.address);
    expect(info.status).to.equal(0); // Manufactured
  });

  it("3. Should prevent non-manufacturer from registering a product", async function () {
    await expect(
      tracker.connect(attacker).registerProduct(serial1, cid1)
    ).to.be.revertedWithCustomError(tracker, "AccessControlUnauthorizedAccount");
  });

  it("4. Should prevent registering a cloned (duplicate) serial hash", async function () {
    await tracker.connect(manufacturer).registerProduct(serial1, cid1);
    await expect(
      tracker.connect(manufacturer).registerProduct(serial1, cid1)
    ).to.be.revertedWithCustomError(tracker, "ProductAlreadyRegistered");
  });

  it("5. Should revert if serialHash is zero bytes or CID is empty", async function () {
    await expect(
      tracker.connect(manufacturer).registerProduct(ethers.ZeroHash, cid1)
    ).to.be.revertedWithCustomError(tracker, "InvalidSerialHash");

    await expect(
      tracker.connect(manufacturer).registerProduct(serial1, "")
    ).to.be.revertedWithCustomError(tracker, "EmptyMetadataCID");
  });

  it("6. Should return exists=false for non-existent product", async function () {
    const info = await tracker.verifyProduct(serial2);
    expect(info.exists).to.equal(false);
    expect(info.currentOwner).to.equal(ethers.ZeroAddress);
  });

  it("7. Should initiate two-step transfer from manufacturer to retailer", async function () {
    await tracker.connect(manufacturer).registerProduct(serial1, cid1);
    await expect(tracker.connect(manufacturer).initiateTransfer(serial1, retailer.address))
      .to.emit(tracker, "TransferInitiated")
      .withArgs(serial1, manufacturer.address, retailer.address);

    const info = await tracker.verifyProduct(serial1);
    expect(info.status).to.equal(1); // InTransit
    expect(info.pendingOwner).to.equal(retailer.address);
  });

  it("8. Should complete two-step transfer when retailer accepts", async function () {
    await tracker.connect(manufacturer).registerProduct(serial1, cid1);
    await tracker.connect(manufacturer).initiateTransfer(serial1, retailer.address);

    await expect(tracker.connect(retailer).acceptTransfer(serial1))
      .to.emit(tracker, "TransferAccepted")
      .withArgs(serial1, retailer.address, 2); // InRetail

    const info = await tracker.verifyProduct(serial1);
    expect(info.currentOwner).to.equal(retailer.address);
    expect(info.pendingOwner).to.equal(ethers.ZeroAddress);
  });

  it("9. Should set status to Sold when transferred to a regular buyer", async function () {
    await tracker.connect(manufacturer).registerProduct(serial1, cid1);
    await tracker.connect(manufacturer).initiateTransfer(serial1, retailer.address);
    await tracker.connect(retailer).acceptTransfer(serial1);

    await tracker.connect(retailer).initiateTransfer(serial1, buyer.address);
    await expect(tracker.connect(buyer).acceptTransfer(serial1))
      .to.emit(tracker, "TransferAccepted")
      .withArgs(serial1, buyer.address, 3); // Sold
  });

  it("10. Should reject acceptTransfer from unauthorized address", async function () {
    await tracker.connect(manufacturer).registerProduct(serial1, cid1);
    await tracker.connect(manufacturer).initiateTransfer(serial1, retailer.address);

    await expect(
      tracker.connect(attacker).acceptTransfer(serial1)
    ).to.be.revertedWithCustomError(tracker, "NotPendingOwner");
  });

  it("11. Should allow current owner to cancel a pending transfer", async function () {
    await tracker.connect(manufacturer).registerProduct(serial1, cid1);
    await tracker.connect(manufacturer).initiateTransfer(serial1, retailer.address);

    await expect(tracker.connect(manufacturer).cancelTransfer(serial1))
      .to.emit(tracker, "TransferCancelled")
      .withArgs(serial1, manufacturer.address);

    const info = await tracker.verifyProduct(serial1);
    expect(info.status).to.equal(0); // Back to Manufactured
    expect(info.pendingOwner).to.equal(ethers.ZeroAddress);
  });

  it("12. Should reject initiateTransfer by non-owner or to zero/self address", async function () {
    await tracker.connect(manufacturer).registerProduct(serial1, cid1);

    await expect(
      tracker.connect(attacker).initiateTransfer(serial1, buyer.address)
    ).to.be.revertedWithCustomError(tracker, "NotCurrentOwner");

    await expect(
      tracker.connect(manufacturer).initiateTransfer(serial1, ethers.ZeroAddress)
    ).to.be.revertedWithCustomError(tracker, "ZeroAddress");

    await expect(
      tracker.connect(manufacturer).initiateTransfer(serial1, manufacturer.address)
    ).to.be.revertedWithCustomError(tracker, "ZeroAddress");
  });

  it("13. Should freeze product when reported stolen and block transfers", async function () {
    await tracker.connect(manufacturer).registerProduct(serial1, cid1);
    await expect(tracker.connect(manufacturer).reportStolen(serial1))
      .to.emit(tracker, "ProductReportedStolen")
      .withArgs(serial1, manufacturer.address);

    await expect(
      tracker.connect(manufacturer).initiateTransfer(serial1, retailer.address)
    ).to.be.revertedWithCustomError(tracker, "ProductIsStolen");
  });

  it("14. Should prevent accepting an in-transit transfer if product is reported stolen", async function () {
    await tracker.connect(manufacturer).registerProduct(serial1, cid1);
    await tracker.connect(manufacturer).initiateTransfer(serial1, retailer.address);
    await tracker.connect(admin).reportStolen(serial1);

    await expect(
      tracker.connect(retailer).acceptTransfer(serial1)
    ).to.be.revertedWithCustomError(tracker, "ProductIsStolen");
  });

  it("15. Should prevent unauthorized user from reporting product stolen", async function () {
    await tracker.connect(manufacturer).registerProduct(serial1, cid1);
    await expect(
      tracker.connect(attacker).reportStolen(serial1)
    ).to.be.revertedWithCustomError(tracker, "NotCurrentOwner");
  });

  it("16. Should allow admin to recover a stolen product and restore status", async function () {
    await tracker.connect(manufacturer).registerProduct(serial1, cid1);
    await tracker.connect(manufacturer).reportStolen(serial1);

    await expect(tracker.connect(admin).markRecovered(serial1))
      .to.emit(tracker, "ProductRecovered")
      .withArgs(serial1, admin.address);

    const info = await tracker.verifyProduct(serial1);
    expect(info.status).to.equal(0); // Manufactured
  });

  it("17. Should revert markRecovered if called by non-admin or on non-stolen item", async function () {
    await tracker.connect(manufacturer).registerProduct(serial1, cid1);

    await expect(
      tracker.connect(attacker).markRecovered(serial1)
    ).to.be.revertedWithCustomError(tracker, "AccessControlUnauthorizedAccount");

    await expect(
      tracker.connect(admin).markRecovered(serial1)
    ).to.be.revertedWithCustomError(tracker, "InvalidStateTransition");
  });

  it("18. Should revert operations on non-existent product", async function () {
    await expect(
      tracker.connect(manufacturer).initiateTransfer(serial2, buyer.address)
    ).to.be.revertedWithCustomError(tracker, "ProductNotFound");

    await expect(
      tracker.connect(buyer).acceptTransfer(serial2)
    ).to.be.revertedWithCustomError(tracker, "ProductNotFound");

    await expect(
      tracker.connect(manufacturer).cancelTransfer(serial2)
    ).to.be.revertedWithCustomError(tracker, "ProductNotFound");

    await expect(
      tracker.connect(manufacturer).reportStolen(serial2)
    ).to.be.revertedWithCustomError(tracker, "ProductNotFound");

    await expect(
      tracker.connect(admin).markRecovered(serial2)
    ).to.be.revertedWithCustomError(tracker, "ProductNotFound");
  });
});