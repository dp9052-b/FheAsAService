pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract FheAsAServiceFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;
    uint256 public cooldownSeconds = 60; // Default 1 minute cooldown

    bool public paused;
    uint256 public currentBatchId = 1;
    bool public batchOpen = false;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    // Encrypted data storage
    mapping(uint256 => euint32) public encryptedData;
    mapping(uint256 => ebool) public encryptedFlags;
    uint256 public dataCount = 0;

    // Custom Errors
    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error BatchClosed();
    error InvalidBatch();
    error ReplayAttempt();
    error StateMismatch();
    error InvalidProof();
    error AlreadyInitialized();
    error NotInitialized();

    // Events
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event CooldownSet(uint256 oldCooldown, uint256 newCooldown);
    event ContractPaused();
    event ContractUnpaused();
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event DataSubmitted(address indexed provider, uint256 indexed batchId, uint256 dataId);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId, bytes32 stateHash);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256[] results, bool[] flags);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier submissionCooldown(address submitter) {
        if (block.timestamp < lastSubmissionTime[submitter] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    modifier decryptionRequestCooldown(address requester) {
        if (block.timestamp < lastDecryptionRequestTime[requester] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true; // Owner is a provider by default
        emit ProviderAdded(owner);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        if (!isProvider[provider]) {
            isProvider[provider] = true;
            emit ProviderAdded(provider);
        }
    }

    function removeProvider(address provider) external onlyOwner {
        if (isProvider[provider]) {
            isProvider[provider] = false;
            emit ProviderRemoved(provider);
        }
    }

    function setCooldown(uint256 newCooldownSeconds) external onlyOwner {
        uint256 oldCooldown = cooldownSeconds;
        cooldownSeconds = newCooldownSeconds;
        emit CooldownSet(oldCooldown, newCooldownSeconds);
    }

    function pause() external onlyOwner whenNotPaused {
        paused = true;
        emit ContractPaused();
    }

    function unpause() external onlyOwner {
        paused = false;
        emit ContractUnpaused();
    }

    function openBatch() external onlyOwner whenNotPaused {
        if (batchOpen) {
            currentBatchId++;
        }
        batchOpen = true;
        emit BatchOpened(currentBatchId);
    }

    function closeBatch() external onlyOwner whenNotPaused {
        if (!batchOpen) revert BatchClosed();
        batchOpen = false;
        emit BatchClosed(currentBatchId);
    }

    function submitEncryptedData(euint32 data, ebool flag) external onlyProvider whenNotPaused submissionCooldown(msg.sender) {
        if (!batchOpen) revert BatchClosed();
        _initIfNeeded(data);
        _initIfNeeded(flag);

        dataCount++;
        encryptedData[dataCount] = data;
        encryptedFlags[dataCount] = flag;

        lastSubmissionTime[msg.sender] = block.timestamp;
        emit DataSubmitted(msg.sender, currentBatchId, dataCount);
    }

    function requestAggregateDecryption() external whenNotPaused decryptionRequestCooldown(msg.sender) {
        if (dataCount == 0) revert InvalidBatch();
        if (batchOpen) revert BatchClosed(); // Must be closed to request decryption

        euint32 memory sum = FHE.asEuint32(0);
        euint32 memory count = FHE.asEuint32(0);
        ebool memory anyFlagTrue = FHE.asEbool(false);

        for (uint256 i = 1; i <= dataCount; i++) {
            sum = sum.add(encryptedData[i]);
            count = count.add(FHE.asEuint32(1));
            anyFlagTrue = anyFlagTrue.or(encryptedFlags[i]);
        }

        euint32 memory average = sum.div(count);
        ebool memory isAverageHigh = average.ge(FHE.asEuint32(100)); // Example threshold

        bytes32[] memory cts = new bytes32[](3);
        cts[0] = average.toBytes32();
        cts[1] = anyFlagTrue.toBytes32();
        cts[2] = isAverageHigh.toBytes32();

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext({
            batchId: currentBatchId,
            stateHash: stateHash,
            processed: false
        });

        lastDecryptionRequestTime[msg.sender] = block.timestamp;
        emit DecryptionRequested(requestId, currentBatchId, stateHash);
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        // 1. Replay Guard
        if (decryptionContexts[requestId].processed) revert ReplayAttempt();

        // 2. State Verification
        // Rebuild ciphertexts array in the exact same order as in requestAggregateDecryption
        euint32 memory sum = FHE.asEuint32(0);
        euint32 memory count = FHE.asEuint32(0);
        ebool memory anyFlagTrue = FHE.asEbool(false);

        for (uint256 i = 1; i <= dataCount; i++) {
            sum = sum.add(encryptedData[i]);
            count = count.add(FHE.asEuint32(1));
            anyFlagTrue = anyFlagTrue.or(encryptedFlags[i]);
        }
        euint32 memory average = sum.div(count);
        ebool memory isAverageHigh = average.ge(FHE.asEuint32(100));

        bytes32[] memory cts = new bytes32[](3);
        cts[0] = average.toBytes32();
        cts[1] = anyFlagTrue.toBytes32();
        cts[2] = isAverageHigh.toBytes32();

        bytes32 currentHash = _hashCiphertexts(cts); // Recalculate hash from current storage state

        if (currentHash != decryptionContexts[requestId].stateHash) {
            revert StateMismatch();
        }

        // 3. Proof Verification
        FHE.checkSignatures(requestId, cleartexts, proof);

        // 4. Decode & Finalize
        uint256[] memory results = new uint256[](2);
        bool[] memory flags = new bool[](1);

        // Decode in the same order ciphertexts were prepared
        results[0] = abi.decode(cleartexts.slice(0, 32), (uint256)); // average
        flags[0] = abi.decode(cleartexts.slice(32, 32), (bool));    // anyFlagTrue
        results[1] = abi.decode(cleartexts.slice(64, 32), (uint256)); // isAverageHigh (bool as uint256)

        decryptionContexts[requestId].processed = true;
        emit DecryptionCompleted(requestId, decryptionContexts[requestId].batchId, results, flags);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 x) internal {
        if (x.isInitialized()) revert AlreadyInitialized();
        if (!FHE.isInitialized()) revert NotInitialized();
    }

    function _initIfNeeded(ebool x) internal {
        if (x.isInitialized()) revert AlreadyInitialized();
        if (!FHE.isInitialized()) revert NotInitialized();
    }

    function _requireInitialized() internal view {
        if (!FHE.isInitialized()) revert NotInitialized();
    }
}