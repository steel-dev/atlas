# Quantum Computing's Progress Toward Practical Applications: Drug Discovery, Cryptography, and Optimization

## Bottom line

As of 2025–2026, quantum computing has crossed important *scientific* thresholds (notably error correction below the surface-code threshold) but remains far from routine practical payoff in the three target domains. The three domains differ sharply in how close they are and in what they demand of hardware:

- **Cryptography** is the most *asymmetric* case: the machine that breaks RSA does not yet exist and will not for years, yet defensive action is urgent *today* because of "harvest-now, decrypt-later." NIST finalized post-quantum standards in August 2024 [1].
- **Optimization and quantum simulation/materials** is where the first contested claims of *practical* quantum advantage are appearing on today's noisy hardware [2], though these claims are vulnerable to classical "dequantization."
- **Drug discovery** is the furthest from payoff — it is fundamentally a *fault-tolerant* application requiring large error-corrected machines that do not yet exist [3].

## 1. State of leading quantum hardware (2025–2026)

| Company | Modality | Physical qubits | Logical qubits | Notable metric |
|---|---|---|---|---|
| Google | Superconducting | 105 (Willow) | demo logical qubit (7×7 surface code) | T1 ≈ 68 µs ± 13 µs [4] |
| IBM | Superconducting | 120 (Nighthawk, late 2025); 156 (Heron-class) | targeting 200 logical by 2029 (Starling) | 5,000 gates; qLDPC "gross" code [[144,12,12]] [5] |
| IonQ | Trapped ion (Yb) | 64 | 0 (roadmap 2027–28) | 99.99% two-qubit gate fidelity (Oct 2025) [6] |
| Quantinuum | Trapped ion (Ba, QCCD) | 98 (Helios, Nov 2025) | 48 error-corrected logical | color code, ~2:1 encoding ratio [6] |
| Atom Computing | Neutral atoms | 1,000+ | 24 entangled / 28 computational (w/ Microsoft) | world-record coherence; all-to-all [7] |

(IonQ/Quantinuum figures from the entangledfuture comparison [6].) The headline takeaway: physical-qubit counts range from tens to ~1,000+, while *logical* (error-corrected) qubit counts are at most a few dozen. IonQ's 99.99% two-qubit fidelity was aided by its $1.075B acquisition of Oxford Ionics (Sep 2025); Quantinuum's Helios demonstrated 48 fully error-corrected logical qubits via a color code; QuEra leads the logical-qubit leaderboard at 96 total logical qubits [6]. Atom Computing and others were selected into DARPA's Quantum Benchmarking Initiative, which aims to test whether an industrially useful machine can be built far faster than conventional predictions; several vendors target utility-scale by ~2033 [7][6].

## 2. Quantum error correction milestones

The pivotal 2024 result was Google's **Willow** chip (Nature s41586-024-08449-y, Dec 2024): the first demonstration of **operating below the surface-code threshold**, a roughly 30-year-old goal. Each increase in surface-code lattice size — 3×3 → 5×5 → 7×7 — **suppressed the encoded error rate by a factor of 2.14**, demonstrating the exponential error suppression that error correction promises. The 7×7 logical qubit lived more than twice as long as its best constituent physical qubit and ~20× longer than Google's previous Sycamore surface code; T1 coherence improved from ~20 µs to 68 µs ± 13 µs. Repetition codes on Willow ran ~10 billion error-correction cycles without error [4].

IBM's path is distinct: rather than the surface code, IBM uses **qLDPC bivariate-bicycle "gross" codes** — the [[144,12,12]] code encodes 12 logical qubits into 144 data + 144 syndrome qubits (288 physical total), correcting as well as the surface code with ~10× fewer qubits. Its roadmap targets **IBM Quantum Starling by 2029**: 100 million gates on 200 logical qubits, via intermediate processors Loon (2025), Kookaburra (2026), Cockatoo (2027) [5]. Quantinuum's Helios demonstrated **48 fully error-corrected logical qubits** and Atom Computing/Microsoft demonstrated **24–28 logical qubits**, marking the leading edge of logical-qubit counts.

## 3. Drug discovery

Drug discovery is the application furthest from practical payoff. The authoritative perspective (*Drug design on quantum computers*, Nature Physics 20:549–557, 2024, co-authored by Boehringer Ingelheim and Google researchers) states plainly that **"quantum computers are still far from being used as daily tools in the pharmaceutical industry."** The target is quantum-chemical (electronic-structure) calculation of how candidate drugs bind targets — environments of several thousand atoms at finite temperature — which requires **substantial further hardware development** and is a **fault-tolerant**, not NISQ, application [3].

Crucially, the same review cites Lee et al. (2023) "Evaluating the evidence for exponential quantum advantage in ground-state quantum chemistry," which found the evidence for an *exponential* speedup in chemistry ground states to be weak — tempering the strongest claims for this domain [3]. Algorithms span near-term **variational quantum eigensolvers (VQE)** and fault-tolerant phase-estimation/qubitization methods.

On partnerships: **Boehringer Ingelheim partnered with Google Quantum AI (Jan 2021)** on molecular-dynamics simulation and set up a dedicated quantum lab; Roche, Pfizer, Merck and others run exploratory programs. No partnership has yet produced a demonstrated drug-discovery result beyond classical capability [3].

## 4. Cryptography — the asymmetric case

Shor's algorithm (1994) lets a sufficiently large quantum computer factor integers efficiently, breaking RSA and elliptic-curve cryptography. The most recent and authoritative cost estimate is **Craig Gidney (Google Quantum AI), arXiv:2505.15917 (May 2025): a 2048-bit RSA integer could be factored in less than a week using fewer than 1 million noisy physical qubits** — about **1,600 logical qubits**, ~12 hours per shot, ~9 shots, ≈4.96 days total, under assumptions of a 0.1% gate error rate, 1 µs surface-code cycle, and 10 µs control reaction time. This is a **20× reduction** from Gidney & Ekerå's 2019 estimate of 20 million qubits / 8 hours [8].

Against today's hardware (tens to ~1,000 *physical* qubits, a few dozen *logical*), this leaves a gap of **three to four orders of magnitude**; no machine can break RSA today and none is expected for years.

This is why cryptography is uniquely asymmetric: even though the attacking machine does not exist, encrypted data captured now can be stored and decrypted later ("harvest-now, decrypt-later"), so defenders must migrate *before* the hardware arrives. Accordingly, NIST finalized the first three post-quantum standards on **August 13, 2024** [1]:

| Standard | Algorithm (origin) | Purpose |
|---|---|---|
| **FIPS 203** | ML-KEM (CRYSTALS-Kyber) | Primary general encryption / key encapsulation |
| **FIPS 204** | ML-DSA (CRYSTALS-Dilithium) | Primary digital signatures |
| **FIPS 205** | SLH-DSA (SPHINCS+) | Backup signatures (different math) |

A fourth standard, FIPS 206 (FN-DSA, based on FALCON), was still in draft. NIST's PQC lead Dustin Moody urged administrators to **"start integrating them into their systems immediately, because full integration will take time,"** and the agency noted some experts predict a code-breaking machine within a decade [1].

## 5. Optimization and quantum simulation

The optimization domain centers on **QAOA** (Quantum Approximate Optimization Algorithm, a NISQ heuristic) and **quantum annealing** (D-Wave). Benchmark studies temper QAOA's promise: empirical evaluations against classical baselines (e.g., Goemans–Williamson for Max-Cut) generally find no clear advantage for off-the-shelf QAOA. **D-Wave** published a peer-reviewed *Science* paper ("Beyond-Classical Computation in Quantum Simulation") claiming the first demonstration of quantum supremacy on a *useful* problem — magnetic-materials simulation it says would take a classical supercomputer nearly a million years.

The most concrete recent advantage claim in this space is **Q-CTRL's** (May 2026, arXiv:2605.04025): a **3,000× wall-clock speedup** on a commercially relevant **Fermionic Simulation (Fermi-Hubbard) materials problem** run on the IBM Quantum Platform with Q-CTRL error-suppression software — **2 minutes versus >100 hours** classically, using **120 qubits and >10,000 two-qubit gates**, benchmarked against the Flatiron Institute's TDVP tensor-network package [2].

## 6. Has genuine quantum advantage been demonstrated for a practical problem?

Partly, and contestedly. Q-CTRL explicitly frames its result as the **first practical quantum advantage** — but with a critical caveat: it claims advantage "relative to what is possible today, rather than as compared against an unknown theoretical possibility," acknowledging that **future specialized classical algorithms or GPU-accelerated TDVP could erode the gap** [2]. This is the central hype-vs-reality tension: claimed quantum speedups have repeatedly been narrowed or eliminated by improved classical methods ("dequantization"). IBM's 2023 "utility before fault tolerance" demonstration (Kim et al., Nature) was subsequently matched by classical tensor-network simulations, and Lee et al. (2023) cast doubt on exponential chemistry advantage [3]. As of 2026, no quantum machine has delivered an *uncontested*, durable advantage on a practical problem in drug discovery, cryptography, or general optimization.

## 7. Timelines and the NISQ-vs-fault-tolerant split

| Domain | Regime needed | Closest to payoff? | Hardware milestone |
|---|---|---|---|
| Optimization / materials simulation | NISQ + error mitigation (now); fault-tolerant for exact chemistry | **Closest** — first contested advantage claims now [2] | Achievable on 100+ physical qubits today |
| Drug discovery | **Fault-tolerant** (large logical-qubit machines) | Furthest [3] | IBM Starling 200 logical qubits, ~2029 [5] |
| Cryptography (breaking RSA) | **Fault-tolerant**, very large | Attack is years away; **defense is now** [8][1] | ~1,600 logical / <1M physical qubits [8] |

Industry timelines: **IBM targets quantum advantage by 2026 and fault tolerance (Starling) by 2029** [5]; DARPA's QBI and several vendors target **utility-scale by ~2033** [7]. NISQ-era applications (optimization heuristics, error-mitigated simulation) run on today's hardware but offer no guaranteed advantage; the high-value applications — exact drug-relevant chemistry and RSA-breaking — both require fault tolerance that is at least several years out.

## 8. Investment and government context

The U.S. National Quantum Initiative (NQI Act, signed Dec 2018) drove rising federal QIS R&D spending: **$456M (FY2019), $690M (FY2020), $851M (FY2021), $1,041M (FY2022), $1,036M (FY2023)**, and the DOE announced **$625M** to renew its five National QIS Research Centers (NQI Annual Report FY2025). Private momentum is equally strong: **IonQ has raised $3.6B+** (and acquired Oxford Ionics for $1.075B), **Quantinuum raised $600M at a $10B valuation (Sep 2025)** and filed to go public at a ~$20B target, and **Atom Computing raised $300M+** [7]. Europe's QuNorth initiative (EIFO + Novo Nordisk Foundation) acquired an Atom Computing system [7].

## Synthesis

The three domains rank, by nearness to practical payoff: **(1) optimization/simulation** (contested advantage claims exist now on NISQ hardware, but classical dequantization is a persistent threat); **(2) cryptography defense** (no attacking machine yet, but NIST standards are final and migration is urgent now — the offensive timeline is years away while the defensive deadline is today); **(3) drug discovery** (requires fault-tolerant machines that won't arrive before ~2029 and faces weak evidence for exponential chemistry speedups). The genuine 2024–2025 breakthroughs are in *error correction* — Willow's below-threshold result and qLDPC/color-code logical-qubit demonstrations — which are the necessary substrate for any of these applications to mature, but they remain a long way from the millions of physical qubits the highest-value applications demand.

## Sources

1. [NIST Releases First 3 Finalized Post-Quantum Encryption Standards](https://www.nist.gov/news-events/news/2024/08/nist-releases-first-3-finalized-post-quantum-encryption-standards)
2. [Q-CTRL Delivers 3,000x Speedup in Materials Discovery for the Energy Sector with Quantum Computing, Demonstrates Evidence of Practical Quantum Advantage | Q-CTRL](https://q-ctrl.com/blog/q-ctrl-delivers-3-000x-speedup-in-materials-discovery-for-the-energy-sector-with-quantum-computing-and-demonstrates-evidence-of-practical-quantum-advantage)
3. [Drug design on quantum computers - Nature Physics](https://www.nature.com/articles/s41567-024-02411-5)
4. [Making quantum error correction work](https://research.google/blog/making-quantum-error-correction-work/)
5. [IBM lays out clear path to fault-tolerant quantum computing | IBM Quantum Computing Blog](https://www.ibm.com/quantum/blog/large-scale-ftqc)
6. [IonQ vs Quantinuum 2026 | Trapped-Ion Quantum Comparison](https://entangledfuture.com/compare/ionq-vs-quantinuum/)
7. [Atom Computing selected by DARPA for the next stage of exploring near-term utility-scale quantum computing with neutral atoms](https://www.prnewswire.com/news-releases/atom-computing-selected-by-darpa-for-the-next-stage-of-exploring-near-term-utility-scale-quantum-computing-with-neutral-atoms-302607998.html)
8. [2505.15917v1](https://arxiv.org/pdf/2505.15917v1)