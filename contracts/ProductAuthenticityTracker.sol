// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";

contract ProductAuthenticityTracker is AccessControl {
    bytes32 public constant MANUFACTURER_ROLE = keccak256("MANUFACTURER_ROLE");
    bytes32 public constant RETAILER_ROLE = keccak256("RETAILER_ROLE");

    enum Status {
        Manufactured,
        InTransit,
        InRetail,
        Sold,
        Stolen
    }

    struct Product {
        bytes32 serialHash;      // بصمة الرقم التسلسلي للحفاظ على الخصوصية ومنع الاستنساخ
        address currentOwner;    // المالك الحالي في سلسلة الإمداد
        uint64 registeredAt;     // وقت التسجيل (Packed with address in 1 storage slot)
        Status status;           // حالة المنتج (Packed in the same storage slot)
        address pendingOwner;    // المستلم المنتظر في آلية التسليم ذي الخطوتين
        string ipfsMetadataCID;  // رابط المواصفات والصور خارج السلسلة (Off-chain)
    }

    mapping(bytes32 => Product) private products;
    mapping(bytes32 => bool) private productExists;

    // Custom Errors لتقليل استهلاك الغاز
    error ZeroAddress();
    error InvalidSerialHash();
    error EmptyMetadataCID();
    error ProductAlreadyRegistered();
    error ProductNotFound();
    error ProductIsStolen();
    error NotCurrentOwner();
    error NotPendingOwner();
    error InvalidStateTransition();

    // Events لكل تغيير في الحالة
    event ProductRegistered(bytes32 indexed serialHash, address indexed manufacturer, string ipfsMetadataCID);
    event TransferInitiated(bytes32 indexed serialHash, address indexed from, address indexed to);
    event TransferAccepted(bytes32 indexed serialHash, address indexed newOwner, Status newStatus);
    event TransferCancelled(bytes32 indexed serialHash, address indexed owner);
    event ProductReportedStolen(bytes32 indexed serialHash, address indexed reporter);
    event ProductRecovered(bytes32 indexed serialHash, address indexed admin);

    constructor(address initialAdmin) {
        if (initialAdmin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, initialAdmin);
    }

    // تسجيل منتج جديد (للمصنعين المعتمدين فقط)
    function registerProduct(
        bytes32 serialHash,
        string calldata ipfsMetadataCID
    ) external onlyRole(MANUFACTURER_ROLE) {
        if (serialHash == bytes32(0)) revert InvalidSerialHash();
        if (bytes(ipfsMetadataCID).length == 0) revert EmptyMetadataCID();
        if (productExists[serialHash]) revert ProductAlreadyRegistered();

        productExists[serialHash] = true;
        products[serialHash] = Product({
            serialHash: serialHash,
            currentOwner: msg.sender,
            registeredAt: uint64(block.timestamp),
            status: Status.Manufactured,
            pendingOwner: address(0),
            ipfsMetadataCID: ipfsMetadataCID
        });

        emit ProductRegistered(serialHash, msg.sender, ipfsMetadataCID);
    }

    // الخطوة 1 من التسليم: المالك الحالي يبدأ نقل الملكية
    function initiateTransfer(bytes32 serialHash, address to) external {
        if (!productExists[serialHash]) revert ProductNotFound();
        if (to == address(0) || to == msg.sender) revert ZeroAddress();

        Product storage item = products[serialHash];
        if (item.status == Status.Stolen) revert ProductIsStolen();
        if (item.currentOwner != msg.sender) revert NotCurrentOwner();
        if (item.status == Status.InTransit) revert InvalidStateTransition();

        item.pendingOwner = to;
        item.status = Status.InTransit;

        emit TransferInitiated(serialHash, msg.sender, to);
    }

    // الخطوة 2 من التسليم: المستلم يؤكد الاستلام لإثبات سلسلة الحيازة
    function acceptTransfer(bytes32 serialHash) external {
        if (!productExists[serialHash]) revert ProductNotFound();

        Product storage item = products[serialHash];
        if (item.status == Status.Stolen) revert ProductIsStolen();
        if (item.status != Status.InTransit) revert InvalidStateTransition();
        if (item.pendingOwner != msg.sender) revert NotPendingOwner();

        item.currentOwner = msg.sender;
        item.pendingOwner = address(0);

        if (hasRole(RETAILER_ROLE, msg.sender)) {
            item.status = Status.InRetail;
        } else {
            item.status = Status.Sold;
        }

        emit TransferAccepted(serialHash, msg.sender, item.status);
    }

    // إلغاء طلب نقل معلق من قبل المالك الحالي
    function cancelTransfer(bytes32 serialHash) external {
        if (!productExists[serialHash]) revert ProductNotFound();

        Product storage item = products[serialHash];
        if (item.currentOwner != msg.sender) revert NotCurrentOwner();
        if (item.status != Status.InTransit) revert InvalidStateTransition();

        item.pendingOwner = address(0);
        item.status = hasRole(MANUFACTURER_ROLE, msg.sender)
            ? Status.Manufactured
            : (hasRole(RETAILER_ROLE, msg.sender) ? Status.InRetail : Status.Sold);

        emit TransferCancelled(serialHash, msg.sender);
    }

    // التبليغ عن سرقة المنتج وتجميده فوراً
    function reportStolen(bytes32 serialHash) external {
        if (!productExists[serialHash]) revert ProductNotFound();

        Product storage item = products[serialHash];
        if (item.currentOwner != msg.sender && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            revert NotCurrentOwner();
        }
        if (item.status == Status.Stolen) revert InvalidStateTransition();

        item.pendingOwner = address(0);
        item.status = Status.Stolen;

        emit ProductReportedStolen(serialHash, msg.sender);
    }

    // فك التجميد من قبل الإدارة في حال استرجاع المنتج
    function markRecovered(bytes32 serialHash) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!productExists[serialHash]) revert ProductNotFound();

        Product storage item = products[serialHash];
        if (item.status != Status.Stolen) revert InvalidStateTransition();

        item.status = hasRole(MANUFACTURER_ROLE, item.currentOwner)
            ? Status.Manufactured
            : (hasRole(RETAILER_ROLE, item.currentOwner) ? Status.InRetail : Status.Sold);

        emit ProductRecovered(serialHash, msg.sender);
    }

    // دالة عامة مجانية للتحقق من أصالة المنتج وحالته
    function verifyProduct(bytes32 serialHash)
        external
        view
        returns (
            bool exists,
            address currentOwner,
            address pendingOwner,
            Status status,
            uint64 registeredAt,
            string memory ipfsMetadataCID
        )
    {
        if (!productExists[serialHash]) {
            return (false, address(0), address(0), Status.Manufactured, 0, "");
        }
        Product storage item = products[serialHash];
        return (
            true,
            item.currentOwner,
            item.pendingOwner,
            item.status,
            item.registeredAt,
            item.ipfsMetadataCID
        );
    }
}