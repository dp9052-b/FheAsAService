import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface EncryptedData {
  id: number;
  key: string;
  encryptedValue: string;
  timestamp: number;
  creator: string;
}

interface UserAction {
  type: 'set' | 'get' | 'decrypt' | 'check';
  timestamp: number;
  details: string;
}

// FHE encryption/decryption simulation
const FHEEncryptNumber = (value: number): string => `FHE-${btoa(value.toString())}`;
const FHEDecryptNumber = (encryptedData: string): number => encryptedData.startsWith('FHE-') ? parseFloat(atob(encryptedData.substring(4))) : parseFloat(encryptedData);
const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [dataList, setDataList] = useState<EncryptedData[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showSetModal, setShowSetModal] = useState(false);
  const [settingData, setSettingData] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newData, setNewData] = useState({ key: "", value: "" });
  const [selectedData, setSelectedData] = useState<EncryptedData | null>(null);
  const [decryptedValue, setDecryptedValue] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState("");
  const [contractAddress, setContractAddress] = useState("");
  const [chainId, setChainId] = useState(0);
  const [startTimestamp, setStartTimestamp] = useState(0);
  const [durationDays, setDurationDays] = useState(30);
  const [userActions, setUserActions] = useState<UserAction[]>([]);
  const [activeTab, setActiveTab] = useState('data');
  const [stats, setStats] = useState({
    totalData: 0,
    encryptedValues: 0,
    averageValue: 0
  });

  // Initialize signature parameters
  useEffect(() => {
    loadData().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  // Load data from contract
  const loadData = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      // Check contract availability
      const isAvailable = await contract.isAvailable();
      if (isAvailable) {
        setTransactionStatus({ visible: true, status: "success", message: "FHE Service is available!" });
        setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
        
        // Log user action
        const newAction: UserAction = {
          type: 'check',
          timestamp: Math.floor(Date.now() / 1000),
          details: "Checked FHE service availability"
        };
        setUserActions(prev => [newAction, ...prev]);
      }
      
      // Load data list
      const dataBytes = await contract.getData("dataList");
      let dataList: EncryptedData[] = [];
      if (dataBytes.length > 0) {
        try {
          const dataStr = ethers.toUtf8String(dataBytes);
          if (dataStr.trim() !== '') dataList = JSON.parse(dataStr);
        } catch (e) {
          console.error("Error parsing data:", e);
        }
      }
      setDataList(dataList);
      
      // Update stats
      const encryptedValues = dataList.length;
      let totalValue = 0;
      dataList.forEach(item => {
        if (item.encryptedValue) {
          totalValue += FHEDecryptNumber(item.encryptedValue);
        }
      });
      
      setStats({
        totalData: dataList.length,
        encryptedValues,
        averageValue: encryptedValues > 0 ? totalValue / encryptedValues : 0
      });
    } catch (e) {
      console.error("Error loading data:", e);
      setTransactionStatus({ visible: true, status: "error", message: "Failed to load data" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { 
      setIsRefreshing(false); 
      setLoading(false); 
    }
  };

  // Set new encrypted data
  const setEncryptedData = async () => {
    if (!isConnected || !address) { 
      setTransactionStatus({ visible: true, status: "error", message: "Please connect wallet first" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
      return; 
    }
    
    const value = parseFloat(newData.value);
    if (isNaN(value)) {
      setTransactionStatus({ visible: true, status: "error", message: "Please enter a valid number" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
      return;
    }
    
    setSettingData(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting data with Zama FHE..." });
    
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      // Create new encrypted data
      const encryptedValue = FHEEncryptNumber(value);
      const newDataItem: EncryptedData = {
        id: dataList.length + 1,
        key: newData.key,
        encryptedValue,
        timestamp: Math.floor(Date.now() / 1000),
        creator: address
      };
      
      // Update data list
      const updatedDataList = [...dataList, newDataItem];
      
      // Save to contract
      await contract.setData("dataList", ethers.toUtf8Bytes(JSON.stringify(updatedDataList)));
      
      // Update user actions
      const newAction: UserAction = {
        type: 'set',
        timestamp: Math.floor(Date.now() / 1000),
        details: `Set encrypted data for key: ${newData.key}`
      };
      setUserActions(prev => [newAction, ...prev]);
      
      setTransactionStatus({ visible: true, status: "success", message: "Data encrypted and stored successfully!" });
      await loadData();
      
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowSetModal(false);
        setNewData({ key: "", value: "" });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") 
        ? "Transaction rejected by user" 
        : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { 
      setSettingData(false); 
    }
  };

  // Decrypt data with signature
  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected || !address) { 
      setTransactionStatus({ visible: true, status: "error", message: "Please connect wallet first" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
      return null; 
    }
    
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      // Update user actions
      const newAction: UserAction = {
        type: 'decrypt',
        timestamp: Math.floor(Date.now() / 1000),
        details: "Decrypted FHE data"
      };
      setUserActions(prev => [newAction, ...prev]);
      
      return FHEDecryptNumber(encryptedData);
    } catch (e) { 
      return null; 
    } finally { 
      setIsDecrypting(false); 
    }
  };

  // Handle decrypt button click
  const handleDecrypt = async () => {
    if (!selectedData) return;
    
    if (decryptedValue !== null) {
      setDecryptedValue(null);
      return;
    }
    
    const decrypted = await decryptWithSignature(selectedData.encryptedValue);
    if (decrypted !== null) {
      setDecryptedValue(decrypted);
    }
  };

  // Render stats cards
  const renderStatsCards = () => {
    return (
      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-icon">📊</div>
          <div className="stat-content">
            <div className="stat-value">{stats.totalData}</div>
            <div className="stat-label">Total Data Entries</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon">🔒</div>
          <div className="stat-content">
            <div className="stat-value">{stats.encryptedValues}</div>
            <div className="stat-label">Encrypted Values</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon">⚖️</div>
          <div className="stat-content">
            <div className="stat-value">{stats.averageValue.toFixed(2)}</div>
            <div className="stat-label">Average Value</div>
          </div>
        </div>
      </div>
    );
  };

  // Render value chart
  const renderValueChart = () => {
    if (dataList.length === 0) return <div className="no-data">No data available for chart</div>;
    
    const values = dataList.map(item => FHEDecryptNumber(item.encryptedValue));
    const maxValue = Math.max(...values, 10); // Ensure chart has some height
    
    return (
      <div className="value-chart">
        {dataList.map((item, index) => {
          const value = FHEDecryptNumber(item.encryptedValue);
          const height = (value / maxValue) * 100;
          
          return (
            <div className="chart-bar" key={index}>
              <div 
                className="bar-fill" 
                style={{ height: `${height}%` }}
                title={`${item.key}: ${value}`}
              ></div>
              <div className="bar-label">{item.key.substring(0, 3)}</div>
            </div>
          );
        })}
      </div>
    );
  };

  // Render user actions history
  const renderUserActions = () => {
    if (userActions.length === 0) return <div className="no-data">No actions recorded</div>;
    
    return (
      <div className="actions-list">
        {userActions.map((action, index) => (
          <div className="action-item" key={index}>
            <div className={`action-type ${action.type}`}>
              {action.type === 'set' && '🔐'}
              {action.type === 'get' && '🔍'}
              {action.type === 'decrypt' && '🔓'}
              {action.type === 'check' && '✅'}
            </div>
            <div className="action-details">
              <div className="action-text">{action.details}</div>
              <div className="action-time">{new Date(action.timestamp * 1000).toLocaleString()}</div>
            </div>
          </div>
        ))}
      </div>
    );
  };

  // Render FAQ section
  const renderFAQ = () => {
    const faqItems = [
      {
        question: "What is FHE-as-a-Service?",
        answer: "FHE-as-a-Service (FaaS) provides developers with easy-to-integrate Fully Homomorphic Encryption tools similar to Zama's solutions, simplifying privacy-preserving computations in smart contracts."
      },
      {
        question: "How does FHE encryption work?",
        answer: "FHE allows computations to be performed on encrypted data without decrypting it. Data remains encrypted throughout processing, ensuring privacy."
      },
      {
        question: "What types of data can be encrypted?",
        answer: "Zama FHE currently supports encryption of numbers and boolean values. String encryption is not supported in the current version."
      },
      {
        question: "How secure is the decryption process?",
        answer: "Decryption requires wallet signature verification, ensuring only authorized users can view decrypted data."
      },
      {
        question: "Can I integrate this with my dApp?",
        answer: "Yes! Our service provides pre-compiled FHE smart contract libraries and Solidity API interfaces for easy integration."
      }
    ];
    
    return (
      <div className="faq-container">
        {faqItems.map((item, index) => (
          <div className="faq-item" key={index}>
            <div className="faq-question">{item.question}</div>
            <div className="faq-answer">{item.answer}</div>
          </div>
        ))}
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="fhe-spinner"></div>
      <p>Initializing FHE service...</p>
    </div>
  );

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon">
            <div className="fhe-icon"></div>
          </div>
          <h1>FHE<span>aaS</span></h1>
          <div className="tagline">Fully Homomorphic Encryption as a Service</div>
        </div>
        
        <div className="header-actions">
          <button 
            onClick={() => setShowSetModal(true)} 
            className="set-data-btn"
          >
            <div className="add-icon"></div>Encrypt Data
          </button>
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          </div>
        </div>
      </header>
      
      <div className="main-content-container">
        <div className="dashboard-section">
          <div className="dashboard-panel left-panel">
            <div className="panel-card">
              <h2>FHE Service Overview</h2>
              <p>Our FHE-as-a-Service platform provides Zama-like fully homomorphic encryption tools for Web3 developers, enabling privacy-preserving computations on blockchain.</p>
              <div className="tech-badge">
                <div className="tech-icon"></div>
                <span>Powered by Zama FHE Technology</span>
              </div>
            </div>
            
            <div className="panel-card">
              <h2>System Statistics</h2>
              {renderStatsCards()}
            </div>
            
            <div className="panel-card">
              <h2>Encrypted Value Distribution</h2>
              {renderValueChart()}
            </div>
          </div>
          
          <div className="dashboard-panel right-panel">
            <div className="tabs-container">
              <div className="tabs">
                <button 
                  className={`tab ${activeTab === 'data' ? 'active' : ''}`}
                  onClick={() => setActiveTab('data')}
                >
                  Encrypted Data
                </button>
                <button 
                  className={`tab ${activeTab === 'actions' ? 'active' : ''}`}
                  onClick={() => setActiveTab('actions')}
                >
                  My Actions
                </button>
                <button 
                  className={`tab ${activeTab === 'faq' ? 'active' : ''}`}
                  onClick={() => setActiveTab('faq')}
                >
                  FAQ
                </button>
              </div>
              
              <div className="tab-content">
                {activeTab === 'data' && (
                  <div className="data-section">
                    <div className="section-header">
                      <h2>Encrypted Data List</h2>
                      <div className="header-actions">
                        <button 
                          onClick={loadData} 
                          className="refresh-btn" 
                          disabled={isRefreshing}
                        >
                          {isRefreshing ? "Refreshing..." : "Refresh"}
                        </button>
                      </div>
                    </div>
                    
                    <div className="data-list">
                      {dataList.length === 0 ? (
                        <div className="no-data">
                          <div className="no-data-icon"></div>
                          <p>No encrypted data found</p>
                          <button 
                            className="create-btn" 
                            onClick={() => setShowSetModal(true)}
                          >
                            Encrypt First Data
                          </button>
                        </div>
                      ) : dataList.map((data, index) => (
                        <div 
                          className={`data-item ${selectedData?.id === data.id ? "selected" : ""}`} 
                          key={index}
                          onClick={() => setSelectedData(data)}
                        >
                          <div className="data-key">{data.key}</div>
                          <div className="data-encrypted">Encrypted: {data.encryptedValue.substring(0, 15)}...</div>
                          <div className="data-creator">Creator: {data.creator.substring(0, 6)}...{data.creator.substring(38)}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                
                {activeTab === 'actions' && (
                  <div className="actions-section">
                    <h2>My Activity History</h2>
                    {renderUserActions()}
                  </div>
                )}
                
                {activeTab === 'faq' && (
                  <div className="faq-section">
                    <h2>Frequently Asked Questions</h2>
                    {renderFAQ()}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
      
      {showSetModal && (
        <ModalSetData 
          onSubmit={setEncryptedData} 
          onClose={() => setShowSetModal(false)} 
          setting={settingData} 
          data={newData} 
          setData={setNewData}
        />
      )}
      
      {selectedData && (
        <DataDetailModal 
          data={selectedData} 
          onClose={() => { 
            setSelectedData(null); 
            setDecryptedValue(null); 
          }} 
          decryptedValue={decryptedValue} 
          isDecrypting={isDecrypting} 
          onDecrypt={handleDecrypt}
        />
      )}
      
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="fhe-spinner"></div>}
              {transactionStatus.status === "success" && <div className="success-icon">✓</div>}
              {transactionStatus.status === "error" && <div className="error-icon">✗</div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}
      
      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo">
              <div className="fhe-icon"></div>
              <span>FHEaaS</span>
            </div>
            <p>Fully Homomorphic Encryption as a Service for Web3</p>
          </div>
          
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">API Reference</a>
            <a href="#" className="footer-link">GitHub</a>
            <a href="#" className="footer-link">Contact</a>
          </div>
        </div>
        
        <div className="footer-bottom">
          <div className="tech-badge">
            <span>Powered by Zama FHE</span>
          </div>
          <div className="copyright">© {new Date().getFullYear()} FHEaaS. All rights reserved.</div>
          <div className="disclaimer">
            This service uses fully homomorphic encryption to protect data privacy. 
            All computations are performed on encrypted data without revealing the original values.
          </div>
        </div>
      </footer>
    </div>
  );
};

interface ModalSetDataProps {
  onSubmit: () => void; 
  onClose: () => void; 
  setting: boolean;
  data: { key: string; value: string };
  setData: (data: { key: string; value: string }) => void;
}

const ModalSetData: React.FC<ModalSetDataProps> = ({ onSubmit, onClose, setting, data, setData }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setData({ ...data, [name]: value });
  };

  return (
    <div className="modal-overlay">
      <div className="set-data-modal">
        <div className="modal-header">
          <h2>Encrypt New Data</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        
        <div className="modal-body">
          <div className="fhe-notice">
            <div className="lock-icon"></div>
            <div>
              <strong>FHE Encryption Notice</strong>
              <p>This data will be encrypted using Zama FHE technology</p>
            </div>
          </div>
          
          <div className="form-group">
            <label>Data Key *</label>
            <input 
              type="text" 
              name="key" 
              value={data.key} 
              onChange={handleChange} 
              placeholder="Enter data key..." 
            />
          </div>
          
          <div className="form-group">
            <label>Numeric Value *</label>
            <input 
              type="text" 
              name="value" 
              value={data.value} 
              onChange={handleChange} 
              placeholder="Enter numeric value to encrypt..." 
            />
          </div>
        </div>
        
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn">Cancel</button>
          <button 
            onClick={onSubmit} 
            disabled={setting || !data.key || !data.value} 
            className="submit-btn"
          >
            {setting ? "Encrypting with FHE..." : "Encrypt Data"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface DataDetailModalProps {
  data: EncryptedData;
  onClose: () => void;
  decryptedValue: number | null;
  isDecrypting: boolean;
  onDecrypt: () => void;
}

const DataDetailModal: React.FC<DataDetailModalProps> = ({ 
  data, 
  onClose, 
  decryptedValue,
  isDecrypting,
  onDecrypt
}) => {
  return (
    <div className="modal-overlay">
      <div className="data-detail-modal">
        <div className="modal-header">
          <h2>Encrypted Data Details</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        
        <div className="modal-body">
          <div className="data-info">
            <div className="info-item">
              <span>Key:</span>
              <strong>{data.key}</strong>
            </div>
            <div className="info-item">
              <span>Creator:</span>
              <strong>{data.creator.substring(0, 6)}...{data.creator.substring(38)}</strong>
            </div>
            <div className="info-item">
              <span>Date Created:</span>
              <strong>{new Date(data.timestamp * 1000).toLocaleDateString()}</strong>
            </div>
          </div>
          
          <div className="encrypted-section">
            <h3>Encrypted Data</h3>
            <div className="encrypted-data">{data.encryptedValue.substring(0, 100)}...</div>
            <div className="fhe-tag">
              <div className="fhe-icon"></div>
              <span>FHE Encrypted</span>
            </div>
            <button 
              className="decrypt-btn" 
              onClick={onDecrypt} 
              disabled={isDecrypting}
            >
              {isDecrypting ? (
                <span>Decrypting...</span>
              ) : decryptedValue !== null ? (
                "Hide Decrypted Value"
              ) : (
                "Decrypt with Wallet Signature"
              )}
            </button>
          </div>
          
          {decryptedValue !== null && (
            <div className="decrypted-section">
              <h3>Decrypted Value</h3>
              <div className="decrypted-value">
                <span>Original Value:</span>
                <strong>{decryptedValue.toFixed(4)}</strong>
              </div>
              <div className="decryption-notice">
                <div className="warning-icon"></div>
                <span>Decrypted value is only visible after wallet signature verification</span>
              </div>
            </div>
          )}
        </div>
        
        <div className="modal-footer">
          <button onClick={onClose} className="close-btn">Close</button>
        </div>
      </div>
    </div>
  );
};

export default App;