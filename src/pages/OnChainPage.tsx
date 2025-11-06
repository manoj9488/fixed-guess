import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Zap, Shield, AlertCircle, CheckCircle2, Clock } from "lucide-react";
import Web3 from "web3";
import Header from "../components/Header";
import { RewardScreen } from "../components/RewardScreen";
import { FailureScreen } from "../components/FailureScreen";
import {
  CyberCard,
  CyberButton,
  HexGrid,
  Scanlines,
  CyberModal,
  CyberBadge,
} from "../components/cyberpunk";
import { useCyberModal } from "../hooks/useCyberModal";
import { getLogicContract } from "../services/eth";
import { npInfura, getRandomBlockHash } from "../services/web3";
import { sendWithFees, isGasFeeError } from "../services/tx";
import type {
  GuessEntry,
  MatchToken,
  WalletProvider,
  TransactionReceipt,
} from "../types";

export default function OnChainPage() {
  const navigate = useNavigate();
  const modal = useCyberModal();

  // Data states
  const [guess, setGuess] = useState<GuessEntry | null>(null);
  const [matches, setMatches] = useState<MatchToken[]>([]);

  // UI states
  const [verifying, setVerifying] = useState(false);
  const [showReward, setShowReward] = useState(false);
  const [showFailure, setShowFailure] = useState(false);
  const [realBlockHash] = useState<string>("");

  // Complex guess calculation
  const [complexCalc, setComplexCalc] = useState<{
    targetBlockHash?: string;
    byteHex?: string;
    adjRanBlockPos?: number;
    randomBlockNumber?: number;
    randomHash?: string;
  } | null>(null);

  // Load data from localStorage
  useEffect(() => {
    const g = localStorage.getItem("singleGuess");
    const m =
      localStorage.getItem("selectedMatches") ||
      localStorage.getItem("matches");

    if (g) {
      try {
        setGuess(JSON.parse(g));
      } catch (error) {
        console.error("Error parsing guess:", error);
      }
    }

    if (m) {
      try {
        setMatches(JSON.parse(m));
      } catch (error) {
        console.error("Error parsing matches:", error);
      }
    }

  }, []);

  // Calculate complex guess data if needed
  useEffect(() => {
    if (!guess?.complex) return;

    const loadComplexData = async () => {
      try {
        const targetBlockNumber = Number(guess.targetBlockNumber);
        const currentBlockNumber = await npInfura.eth.getBlockNumber();
        const distance = Number(currentBlockNumber) - targetBlockNumber;

        if (distance > 128) {
          setComplexCalc(null);
          return;
        }

        const block = await npInfura.eth.getBlock(targetBlockNumber);
        const seedHash = block?.hash;

        if (!seedHash) {
          setComplexCalc(null);
          return;
        }

        const [randomHash, byteHex, adjRanBlockPos, randomBlockNumber] =
          await getRandomBlockHash(seedHash, targetBlockNumber);

        setComplexCalc({
          targetBlockHash: seedHash,
          byteHex,
          adjRanBlockPos,
          randomBlockNumber,
          randomHash: randomHash || undefined,
        });
      } catch (error) {
        console.error("Complex calc error:", error);
        setComplexCalc(null);
      }
    };

    loadComplexData();
  }, [guess?.complex, guess?.targetBlockNumber]);

  // FIXED: Handle verification
  const handleVerifyOnChain = async () => {
    try {
      const account = localStorage.getItem("currentAccount");
      const logicAddr = localStorage.getItem("logicCrtAddress");

      if (!account || !logicAddr || !guess) {
        modal.open({
          title: "Missing Data",
          message: "Please go back and try again.",
          type: "error",
        });
        return;
      }

      if (matches.length === 0) {
        modal.open({
          title: "No Matches",
          message: "No matches selected for verification.",
          type: "warning",
        });
        return;
      }

      setVerifying(true);

      // Convert hex strings to proper bytes format
      const convertHexToBytes = (hexString: string): string => {
        if (!hexString) return "0x";

        let cleanHex = hexString.replace(/[\s\n\r]/g, "").replace(/^0x/, "");

        if (cleanHex.length % 2 !== 0) {
          cleanHex = "0" + cleanHex;
        }

        return "0x" + cleanHex;
      };

      const code1 = convertHexToBytes(matches[0]?.encoded || "0x");
      const code2 = convertHexToBytes(matches[1]?.encoded || "0x");

      // Validate input data
      if (typeof guess.actualHash !== "string" || !guess.actualHash) {
        throw new Error("Invalid actual hash: must be a non-empty string");
      }

      if (typeof guess.secretKey !== "string" || !guess.secretKey) {
        throw new Error("Invalid secret key: must be a non-empty string");
      }

      if (typeof guess.guessId !== "number" || guess.guessId <= 0) {
        throw new Error("Invalid guess ID: must be a positive number");
      }

      if (!guess.actualHash.startsWith("0x") || guess.actualHash.length < 66) {
        throw new Error("Invalid actual hash format");
      }

      if (!guess.secretKey.startsWith("0x")) {
        throw new Error("Invalid secret key format");
      }

      const provider =
        (
          window as {
            selectedWallet?: { ethereum?: WalletProvider };
            ethereum?: WalletProvider;
          }
        ).selectedWallet?.ethereum ||
        (
          window as {
            ethereum?: WalletProvider;
          }
        ).ethereum;

      if (!provider) {
        modal.open({
          title: "No Wallet Provider",
          message: "Open MetaMask and retry.",
          type: "error",
        });
        setVerifying(false);
        return;
      }

      const web3 = new Web3(provider as never);
      const logic = getLogicContract(web3, logicAddr);

      console.log("Verification Data (Formatted):", {
        guessId: guess.guessId,
        actualHash: guess.actualHash,
        secretKey: guess.secretKey,
        code1_length: code1.length,
        code2_length: code2.length,
      });

      modal.open({
        title: "Preparing Verification",
        message: "Confirm the transaction in your wallet...",
        type: "info",
      });

      await sendWithFees(
        web3,
        logic.methods.verifyBlockGuess(
          guess.guessId,
          guess.actualHash,
          guess.secretKey,
          [code1, code2],
        ),
        { from: account },
        {
          onHash: () => {
            modal.open({
              title: "Transaction Submitted",
              message:
                "Your transaction is being confirmed. Do NOT refresh the page.",
              type: "info",
            });
          },
          onReceipt: async (receipt: TransactionReceipt) => {
            if (!receipt?.status) {
              throw new Error("Verification transaction failed");
            }

            const ev = receipt.events?.guessVerified?.returnValues as
              | Record<string, unknown>
              | undefined;
            if (!ev) {
              throw new Error("No verification event found");
            }

            const targetStatus = Number(
              (ev as any)._targetStatus ?? (ev as any).targetStatus ?? 0,
            );
            const rewardsTotal = String(
              (ev as any)._rewardsTotal ?? (ev as any).rewardsTotal ?? "0",
            );
            const isVerified = targetStatus === 2;

            if (isVerified) {
              const rewards = npInfura.utils.fromWei(rewardsTotal, "ether");
              modal.open({
                title: "Verified!",
                message:
                  Number(rewardsTotal) > 0
                    ? `Rewards minted: ${rewards} GUESS`
                    : "Verified successfully",
                type: "success",
              });
              localStorage.setItem("verificationComplete", "true");
              localStorage.setItem("verificationResult", "success");
            } else {
              modal.open({
                title: "Verification Completed",
                message: "Verified with no rewards",
                type: "info",
              });
              localStorage.setItem("verificationComplete", "true");
              localStorage.setItem("verificationResult", "failure");
            }

            setVerifying(false);
            setTimeout(() => {
              modal.close();
              navigate("/home");
            }, 1500);
          },
        },
      );
    } catch (error: unknown) {
      const err = error as {
        code?: number;
        message?: string;
      };

      console.error("Verification error:", err);

      if (err?.code === 4001) {
        modal.open({
          title: "Transaction Rejected",
          message: "You rejected the transaction in your wallet.",
          type: "error",
        });
      } else if (isGasFeeError(err)) {
        modal.open({
          title: "Gas Fee Issue",
          message:
            "Gas fee is too low. Please increase the gas fee and try again.",
          type: "warning",
        });
      } else if (
        err?.message?.includes("Expected array") ||
        err?.message?.includes("Web3ValidatorError")
      ) {
        modal.open({
          title: "Data Format Error",
          message:
            "Parameter format error. Ensure all encoded data is valid hex strings.",
          type: "error",
        });
      } else if (err?.message?.includes("No matches found")) {
        modal.open({
          title: "No Matches Found",
          message: "On-chain verification did not find any matching tokens.",
          type: "warning",
        });
      } else if (err?.message?.includes("Invalid")) {
        modal.open({
          title: "Validation Error",
          message: err.message,
          type: "error",
        });
      } else {
        modal.open({
          title: "Verification Failed",
          message:
            err?.message ||
            "An error occurred during verification. Please try again.",
          type: "error",
        });
      }

      setVerifying(false);
    }
  };

  if (!guess) {
    return (
      <div className="min-h-screen relative bg-cyber-darker">
        <HexGrid />
        <Scanlines />
        <Header
          trail={[{ label: "Verify on Chain" }]}
          onLogout={() => {
            localStorage.clear();
            window.location.href = "/session";
          }}
        />
        <main className="relative z-10 max-w-5xl mx-auto px-4 pt-24 pb-12">
          <CyberCard glow className="text-center py-12">
            <AlertCircle className="w-12 h-12 text-amber-400 mx-auto mb-4" />
            <p className="text-gray-300 font-mono mb-4">
              No guess data found. Please start from the beginning.
            </p>
            <CyberButton variant="primary" onClick={() => navigate("/home")}>
              Return to Home
            </CyberButton>
          </CyberCard>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen relative bg-cyber-darker">
      <HexGrid />
      <Scanlines />
      <Header
        trail={[{ label: "Home", to: "/home" }, { label: "Verify on Chain" }]}
        onLogout={() => {
          localStorage.clear();
          window.location.href = "/session";
        }}
      />

      <main className="relative z-10 max-w-6xl mx-auto px-4 pt-24 pb-12 space-y-8">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center mb-12"
        >
          <h1 className="text-4xl font-display font-bold text-cyan-300 mb-4 cyber-text-glow">
            ON-CHAIN VERIFICATION
          </h1>
          <p className="text-gray-200 font-mono">
            Verify your guess against the blockchain
          </p>
        </motion.div>

        {/* Main Content Grid */}
        <div className="grid lg:grid-cols-2 gap-8">
          {/* Left: Guess Details */}
          <motion.div
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            className="space-y-6"
          >
            <div>
              <h2 className="text-2xl font-display font-bold text-purple-300 mb-4">
                GUESS DATA
              </h2>
              <div className="h-1 w-32 bg-gradient-to-r from-purple-500 to-cyan-400 rounded-full" />
            </div>

            <CyberCard glow>
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-xs text-gray-300 mb-2 uppercase tracking-wider">
                      Guess ID
                    </p>
                    <p className="font-mono text-lg font-bold text-cyan-300">
                      #{guess.guessId}
                    </p>
                  </div>

                  <div>
                    <p className="text-xs text-gray-300 mb-2 uppercase tracking-wider">
                      Token Size
                    </p>
                    <p className="font-mono text-lg font-bold text-cyan-300">
                      {guess.tokenSize} bytes
                    </p>
                  </div>

                  <div>
                    <p className="text-xs text-gray-300 mb-2 uppercase tracking-wider">
                      Payment
                    </p>
                    <CyberBadge
                      variant={guess.paidGuess ? "success" : "warning"}
                    >
                      {guess.paidGuess ? "PAID" : "FREE"}
                    </CyberBadge>
                  </div>

                  <div>
                    <p className="text-xs text-gray-300 mb-2 uppercase tracking-wider">
                      Complexity
                    </p>
                    <CyberBadge variant={guess.complex ? "warning" : "success"}>
                      {guess.complex ? "COMPLEX" : "SIMPLE"}
                    </CyberBadge>
                  </div>
                </div>

                <div className="pt-4 border-t border-gray-700/30 space-y-3">
                  <div>
                    <p className="text-xs text-gray-300 mb-1 uppercase tracking-wider">
                      Actual Hash
                    </p>
                    <p className="font-mono break-all text-sm text-cyan-200 leading-relaxed">
                      {guess.actualHash}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-300 mb-1 uppercase tracking-wider">
                      Secret Key
                    </p>
                    <p className="font-mono break-all text-sm text-cyan-200 leading-relaxed">
                      {guess.secretKey}
                    </p>
                  </div>
                </div>
              </div>
            </CyberCard>

            {guess.complex && complexCalc && (
              <CyberCard
                glow
                className="bg-gradient-to-br from-amber-900/30 to-amber-900/20 border-amber-500/40"
              >
                <h3 className="text-lg font-semibold text-amber-300 mb-4 flex items-center gap-2">
                  <Zap className="w-5 h-5" />
                  Complex Guess Data
                </h3>
                <div className="space-y-3 text-sm font-mono">
                  <div>
                    <p className="text-gray-300 text-xs mb-1 uppercase tracking-wider">
                      Target Block Hash:
                    </p>
                    <p className="break-all text-amber-200">
                      {complexCalc.targetBlockHash}
                    </p>
                  </div>
                  <div>
                    <p className="text-gray-300 text-xs mb-1 uppercase tracking-wider">
                      Random Block Number:
                    </p>
                    <p className="text-amber-200 font-bold">
                      {complexCalc.randomBlockNumber}
                    </p>
                  </div>
                </div>
              </CyberCard>
            )}
          </motion.div>

          {/* Right: Matches & Encoded Data */}
          <motion.div
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            className="space-y-6"
          >
            <div>
              <h2 className="text-2xl font-display font-bold text-purple-300 mb-4">
                ENCODED MATCHES ({matches.length})
              </h2>
              <div className="h-1 w-32 bg-gradient-to-r from-purple-500 to-cyan-400 rounded-full" />
            </div>

            {matches.length > 0 ? (
              matches.map((match, index) => (
                <motion.div
                  key={index}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: index * 0.1 }}
                >
                  <CyberCard glow>
                    <div className="space-y-3">
                      <div className="flex items-center gap-2">
                        <CheckCircle2 className="w-5 h-5 text-green-300" />
                        <h3 className="font-semibold text-green-300">
                          Match #{index + 1}
                        </h3>
                      </div>

                      <div className="bg-gray-900/60 rounded p-3 border border-gray-700/50">
                        <p className="text-xs text-gray-300 mb-1 uppercase tracking-wider">
                          Token:
                        </p>
                        <p className="font-mono break-all text-sm text-cyan-200">
                          {match.token}
                        </p>
                      </div>

                      <details className="group">
                        <summary className="cursor-pointer text-sm font-mono text-cyan-300 hover:text-cyan-200 flex items-center gap-2 font-semibold">
                          <span className="group-open:rotate-90 transition-transform">
                            ▶
                          </span>
                          Encoded Data
                        </summary>
                        <pre className="mt-3 overflow-auto text-xs text-cyan-200 bg-gray-900/80 p-3 rounded font-mono break-all border border-gray-700/50 max-h-40 leading-relaxed">
                          {typeof match.encoded === "string"
                            ? match.encoded
                            : JSON.stringify(match.encoded)}
                        </pre>
                      </details>
                    </div>
                  </CyberCard>
                </motion.div>
              ))
            ) : (
              <CyberCard glow className="text-center py-8">
                <AlertCircle className="w-8 h-8 text-amber-400 mx-auto mb-2" />
                <p className="text-gray-300 font-mono text-sm">
                  No matches selected
                </p>
              </CyberCard>
            )}
          </motion.div>
        </div>

        {/* Verification Status */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4 }}
          className="bg-gradient-to-r from-cyan-500/15 to-purple-500/15 border-2 border-cyan-400/50 rounded-lg p-6"
        >
          <div className="flex items-center gap-3 mb-2">
            <Clock className="w-5 h-5 text-cyan-300" />
            <h3 className="font-semibold text-cyan-300">
              Ready for Verification
            </h3>
          </div>
          <p className="text-sm text-gray-200">
            Click the verify button below to submit your guess to the blockchain
            for verification.
          </p>
        </motion.div>

        {/* Action Buttons */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.5 }}
          className="flex flex-col sm:flex-row gap-4 justify-end pt-8"
        >
          <CyberButton
            variant="secondary"
            onClick={() => navigate("/matches")}
            disabled={verifying}
          >
            Back to Matches
          </CyberButton>

          <CyberButton
            variant="primary"
            onClick={handleVerifyOnChain}
            disabled={verifying || matches.length === 0}
            icon={<Shield className="w-4 h-4" />}
          >
            {verifying ? "Verifying..." : "Verify on Chain"}
          </CyberButton>
        </motion.div>
      </main>

      {/* Reward Screen */}
      <AnimatePresence>
        {showReward && (
          <RewardScreen
            onComplete={() => {
              setShowReward(false);
              localStorage.clear();
              navigate("/home");
            }}
            realBlockHash={realBlockHash}
          />
        )}
      </AnimatePresence>

      {/* Failure Screen */}
      <AnimatePresence>
        {showFailure && (
          <FailureScreen
            onComplete={() => {
              setShowFailure(false);
              localStorage.clear();
              navigate("/home");
            }}
            actualHash={guess.actualHash || ""}
            realBlockHash={realBlockHash}
          />
        )}
      </AnimatePresence>

      {/* Modal */}
      <CyberModal
        isOpen={modal.isOpen}
        onClose={modal.close}
        {...modal.config}
        onConfirm={modal.onConfirm || undefined}
      />
    </div>
  );
}
