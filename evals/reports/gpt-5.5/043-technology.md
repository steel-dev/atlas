# Quantum computing progress toward practical applications in drug discovery, cryptography, and optimization

## Bottom line as of 2026-06-23

Practical maturity differs sharply by domain. **Cryptography is already operational** because post-quantum cryptography (PQC) standards now exist and migration programs are underway, even though cryptographically relevant quantum computers (CRQCs) have not arrived. **Optimization is in pilot/hybrid mode**: quantum annealers and gate-model variational methods are being tested on QUBO/Ising, Max-Cut, routing, scheduling, and portfolio-style formulations, but advantage claims remain benchmark-contested and depend on the metric chosen. **Drug discovery is scientifically promising but mostly pre-commercial**: the value chain is clear—electronic structure, binding energetics, active-site chemistry, and quantum-enhanced ML/screening—but today’s devices mainly support method development and small-to-medium demonstrations; chemically decisive advantage still appears to require fault-tolerant quantum computers with orders-of-magnitude more reliable logical operations.

The hardware reason is straightforward. Recent systems have crossed important thresholds in qubit count, fidelity, and error-correction demonstrations, but **none of the sourced systems is a production, fault-tolerant computer capable of long, chemically or cryptographically relevant workloads**. IBM’s Heron family is at 133/156 superconducting qubits with headline 156-qubit metrics including EPLG 2.28E-3 and CLOPS 340K; IBM Condor reached 1,121 superconducting qubits as a scale/yield milestone; Google Willow has 105 qubits and demonstrated below-threshold surface-code memory; Quantinuum H2 reached 56 trapped-ion qubits and demonstrated logical-qubit error suppression. Those are major milestones, but IBM’s own roadmap still places 100-million-gate, 200-logical-qubit error-corrected operation at its planned 2029 Starling system and 1-billion-gate, 2,000-qubit operation at planned 2033 Blue Jay—not at today’s deployed machines [1][2][3][4][5].

## 1. Hardware readiness: what exists, and what is still missing

| Platform / milestone | Latest sourced status | What it proves | Readiness caveat |
|---|---:|---|---|
| **IBM Heron** | 133 or 156 fixed-frequency superconducting qubits with tunable couplers; Heron r2, July 2024, had 156 qubits; hardware page lists 156 qubits, EPLG 2.28E-3, CLOPS 340K; Heron r3, July 2025, improved coherence, gate fidelity, and readout [1] | Useful high-quality NISQ-scale processor for hybrid circuits and quantum-centric workflows | Not a production FTQC; current devices plus error mitigation remain limited to small circuits relative to practical workloads [2] |
| **IBM Condor** | 1,121 superconducting qubits, announced Dec. 2023, based on cross-resonance gates; performance comparable to 433-qubit Osprey [2] | Scale/yield milestone: >1,000 physical qubits | Not positioned as a high-fidelity, fault-tolerant production system [2] |
| **IBM FTQC roadmap** | Starling target: 100 million gates over 200 qubits in 2029; Blue Jay target: 1 billion gates over 2,000 qubits by 2033 [2] | Vendor roadmap acknowledges need for error correction and much deeper circuits | Future target, not current capability [2] |
| **Google Willow** | 105 qubits; simultaneous 1Q gate error 0.035% ± 0.029%; simultaneous 2Q CZ error 0.33% ± 0.18%; measurement error 0.77% ± 0.21%; T1 68 μs ± 13 μs; 1.1 μs surface-code cycle [6] | High-fidelity superconducting system with fast surface-code cycling | Still a physical-qubit processor; practical workloads require many logical qubits and long logical circuits [6][3] |
| **Google below-threshold QEC** | Distance-5 surface-code memory on 72-qubit processor with real-time decoder; distance-7 on 105-qubit processor; 101-qubit distance-7 logical memory error 0.143% ± 0.003% per correction cycle, Λ=2.14 ± 0.02 per distance+2, lifetime 2.4 ± 0.3× best physical qubit; d=5 real-time decoder latency 63 μs [3] | Error correction improves with code distance—an essential threshold milestone | A memory demonstration, not a general-purpose, fault-tolerant workload computer [3] |
| **Quantinuum H2-1** | 56 trapped-ion qubits as of June 5, 2024; H-Series claimed 99.9% two-qubit fidelity across all qubit pairs; random-circuit-sampling cross-entropy benchmark claimed 100× prior industry benchmark and 30,000× lower power than classical supercomputers for that benchmark [4] | High-fidelity, all-to-all trapped-ion platform; strong benchmarking and energy-use claims for RCS | RCS is not a production optimization, chemistry, or cryptography workload [4] |
| **Microsoft/Quantinuum logical qubits** | Apr. 3, 2024: 4 logical qubits from 30 physical qubits, logical error rate 800× better than physical and >14,000 experiments without one error; Sept. 10, 2024: 12 logical qubits on 56-qubit H2; 12-logical-qubit GHZ/cat circuit error 0.0011 vs 0.024 physical, and 8 logical qubits with repeated error correction and fault-tolerant computation at 0.002 vs 0.023 physical [5][7] | Logical encoding and repeated correction can outperform physical operation on real hardware | Still small logical-qubit demonstrations, not large-scale FTQC [5][7] |

The readiness gap is therefore not “number of physical qubits” alone. The hard gap is the number of **high-quality logical qubits multiplied by circuit depth**. The drug-discovery and cryptography-relevant algorithms discussed below require long sequences of fault-tolerant operations; present devices mainly execute noisy or error-mitigated circuits, logical memories, and small logical circuits.

## 2. Drug discovery: where quantum computing is expected to matter

The strongest drug-discovery case is not that quantum computers will replace today’s classical AI drug-discovery pipeline. It is that they may eventually improve the **physics bottlenecks** that classical approximations and data-driven models struggle with.

The relevant value chain is:

1. **Quantum chemistry / electronic structure.** Drug discovery and adjacent medicinal chemistry require energies, charge distributions, reaction barriers, excited states, and strongly correlated active sites. Quantum algorithms target the electronic Schrödinger equation directly, which is naturally quantum mechanical.
2. **Molecular binding and protein-ligand interactions.** Binding affinity depends on noncovalent interactions, polarization, solvent, entropy, and local electronic effects. Quantum computing is most plausible for high-accuracy fragments, active sites, or embedding regions—not for simulating an entire protein atom-by-atom on a near-term processor.
3. **Enzymatic and catalyst-like chemistry.** Pharma-relevant chemistry includes covalent inhibition, prodrug activation, metalloenzymes, iron-sulfur clusters, and cytochrome-P450-like or catalyst-like active spaces. These are the same kinds of strongly correlated electronic-structure problems used in resource estimates and demonstrations.
4. **ML-assisted screening.** Classical AI/ML screens libraries, predicts structures, ranks candidates, and proposes molecules from learned data. Quantum computing could assist by generating more accurate labels, kernels, embeddings, or subproblem solvers, but it is not the same workflow as training AlphaFold-like or QSAR-like classical models.

A useful distinction is: **classical AI/ML drug discovery is primarily statistical pattern learning from data; quantum chemistry is first-principles simulation of quantum systems.** The sourced drug-discovery review treats quantum components as focused evaluators alongside classical pipelines, with classical tools handling large-scale pose enumeration, scoring, and ranking, and says standardized hardware-run quantum benchmarks at CASF-2016, CrossDocked2020, or PoseBusters scale are not yet available [8]. The two approaches are therefore likely to be combined—e.g., quantum calculations for hard fragments feeding classical workflows—rather than one replacing the other.

### Recent quantum-chemistry and drug-discovery demonstrations

| Date / organization | Hardware or simulator | Problem size | Algorithm / method | Result versus classical methods |
|---|---|---:|---|---|
| **23 July 2024, Tencent/others, Scientific Reports** | Superconducting quantum device | Prodrug activation and KRAS covalent inhibition workflow; chemistry reduced to a (2e,2o) active space on **2 qubits** | VQE, parity mapping, hardware-efficient Ry ansatz, readout-error mitigation | Reproduced / matched active-space CASCI expectations rather than beating classical. Molecule 5 active-space solve: CASCI 3 s vs QPU 63 s; quantum kernel ~60 s due to 8192 shots per Pauli and 8 Pauli strings grouped into 5 groups [9] |
| **Oct. 2024, Cleveland Clinic / IBM / MSU** | IBM Eagle processors, ibm_cleveland and ibm_kyiv | Water dimer (16e,12o) on 27 qubits; methane dimer (16e,16o) on 36 qubits; methane dimer (16e,24o) on 54 qubits | Sample-Based Quantum Diagonalization (SQD), LUCJ circuits, gate twirling, dynamical decoupling | 27/36-qubit results agreed with CASCI and CCSD(T) within 1 kcal/mol near PES equilibrium; 54-qubit case tested capacity. Binding-relevant but not a best-classical win [10] |
| **Science Advances Vol. 11 Issue 25, 2025; IBM/RIKEN; arXiv v3 May 13, 2025; DOI 10.1126/sciadv.adu9991** | IBM 133-qubit Heron + Fugaku | N2 dissociation and [2Fe-2S]/[4Fe-4S] clusters using 58, 45, and 77 qubits; circuits up to 10,570 gates and ~3.5k two-qubit gates; largest run used 77-qubit subset with 2Q fidelity 99.77%, 1Q 99.97%, readout 98.37%, T1=180 μs, T2=150 μs | SQD / quantum-centric supercomputing | Reached active spaces beyond exact diagonalization; [4Fe-4S] quantum solutions were worse than other classical methods but better than uniform/noise sampling. No best-classical advantage [11][12] |
| **May 5, 2026, IBM / Cleveland Clinic / RIKEN; arXiv 2605.01138** | Two 156-qubit IBM Heron r2 processors, ibm_cleveland and ibm_kobe; HPC postprocessing on Fugaku and Miyabi-G | T4-lysozyme + n-butyl-benzene in water: 11,608 atoms, 28,844 orbitals, PDB 4W57; trypsin + benzamidine in water: 12,635 atoms, 31,795 orbitals, PDB 3PTB; up to 94 qubits; 9,200 circuits; >100 QPU hours; 1.3e9 measurement outcomes | Quantum embedding + heterogeneous quantum-classical / quantum-centric supercomputing | Matched CCSD fragment-energy accuracy and claimed >40× size increase and up to 210× accuracy improvement over previous QCSC, but IBM explicitly stated it does not yet outperform best classical approaches [13] |

The pattern is consistent: near-term devices are beginning to produce chemically meaningful signals at tens of qubits and, with embedding, biomolecular-scale workflows. But the demonstrations either reproduce classical active-space methods, match selected classical-quality fragment results, or improve over noise/uniform sampling—not over the best end-to-end classical chemistry or AI pipeline.

### Fault-tolerant resource estimates for chemically relevant problems

The fault-tolerant estimates show why today’s NISQ demonstrations should not be confused with practical quantum drug discovery.

| Target problem | Algorithmic approach | Logical resources | Runtime / depth metric | Physical-qubit implication |
|---|---|---:|---:|---:|
| **FeMoco**, active spaces 54e/54o and 65e/57o | Phase estimation with Trotterized chemistry simulation | For 0.1 mHa: 117 logical qubits / 2.0e15–3.1e15 T gates / 240 days in serial; 142 logical qubits / 6.5e15–1.0e16 T gates / 27 days with nesting; 2024 logical qubits / 6.0e16 T gates / 204 hours in PAR. For 1 mHa, roughly 10× lower T-gate costs; nesting 3.3e14–6.0e14 T gates, 135/142 logical qubits, 1.4–2.5 days; PAR 3.0e15–5.5e15 T gates, 1982/2024 logical qubits, 11–20 hours [14] | T-counts from 1e14 to 1e16+ depending accuracy/parallelization | Surface-code estimates at 100 MHz physical gates: for structure 1, 0.1 mHa, physical error 1e-6 implies ~1.2e6 physical qubits serial, 3.0e7 nested, 3.1e9 PAR; physical error 1e-9 implies ~2.3e5 serial, 5.2e6 nested, 1.5e8 PAR [14] |
| **Homogeneous CO2-fixation catalyst structures**, 52–65 orbitals and 48–76 electrons | Double-factorization / qubitization phase estimation | Roughly 1e10–1e11 Toffoli gates and ~4000 logical qubits. Examples: Structure I, 52 orbitals/48e, 3400 qubits and 1.3e10 Toffolis or 6900 qubits/1.1e10 Toffolis; Structure VIII, 65 orbitals/76e, 4400 qubits and 4.6e10 Toffolis or 8900/3.8e10 [15] | At 10 μs per Toffoli, days to weeks; at 10 ms per Toffoli, years [15] | ~4000 logical qubits implies millions of physical qubits under surface-code-style overheads [15] |

The newer qubitization/double-factorization estimates are far more encouraging than early Trotter estimates, but they still require thousands of logical qubits and very large numbers of fault-tolerant gates. That is why the near-term route is best understood as **algorithm and workflow development**—VQE/SQD, embedding, error mitigation, measurement reduction, and QPU-HPC orchestration—while the highest-value chemistry advantage likely depends on **error correction, logical-qubit scaling, and resource reductions**.

## 3. Cryptography: the impact is practical now, before CRQCs exist

Cryptography is the most mature “application” area because the near-term action is not running Shor’s algorithm on today’s machines; it is replacing vulnerable public-key cryptography before a future CRQC can exploit recorded data.

The threat is specific:

- **Shor’s algorithm** on a CRQC efficiently solves integer factorization and discrete-logarithm problems. That threatens RSA, finite-field Diffie-Hellman, elliptic-curve Diffie-Hellman / ECC, ElGamal/Schnorr variants, and public-key signatures/key exchange based on those assumptions. The remedy is replacement, not merely larger RSA/DH/ECC keys [16].
- **Grover’s algorithm** gives a theoretical quadratic speedup for unstructured search. It affects brute-force symmetric key search and hash preimage search, but less severely; larger symmetric keys or digest lengths can mitigate where needed. RFC 9958 notes AES-128 remains considered quantum-safe for the foreseeable future, although some compliance profiles prefer AES-256 [16].

### NIST PQC standardization status as of 2026-06-23

| Standard / candidate | Algorithm | Function | Status |
|---|---|---|---|
| **FIPS 203** | ML-KEM, derived from CRYSTALS-KYBER | Key encapsulation / key establishment | Published Aug. 13, 2024 [17][18] |
| **FIPS 204** | ML-DSA, derived from CRYSTALS-Dilithium | Digital signatures | Published Aug. 13, 2024 [17][18] |
| **FIPS 205** | SLH-DSA, derived from SPHINCS+ | Stateless hash-based digital signatures | Published Aug. 13, 2024 [17][18] |
| **FIPS 206, in development** | FN-DSA / Falcon | Digital signatures | Falcon selected in 2022; NIST page says FIPS 206 is in development / “FIPS coming soon” [17][18] |
| **HQC FIPS, in development** | HQC | Additional KEM / key establishment | Selected for standardization on March 11, 2025; FIPS “coming soon” [17][18][19] |

The deployment timeline and the quantum-computer timeline are different. PQC standards and hybrid deployments can be used now on classical computers; a CRQC arrival date remains uncertain. That mismatch is exactly why migration is urgent: adversaries can **harvest now, decrypt later** by storing encrypted traffic or documents today and decrypting them after a CRQC exists.

### Migration guidance and dates

- **NSM-10, May 4, 2022** directed U.S. agencies to inventory vulnerable cryptographic systems and prepare for PQC migration [20].
- **OMB M-23-02, Nov. 18, 2022** required reporting to the Office of the National Cyber Director and CISA for cryptographic systems using quantum-vulnerable cryptography [20].
- **CISA Sept. 2024 automated discovery and inventory strategy** applies to Federal Civilian Executive Branch systems, excluding NSS, and prioritizes high-impact systems, High Value Assets, and systems containing data that would remain mission-sensitive in **2035**—an explicit harvest-now/decrypt-later criterion. Inventory data include algorithm, cryptographic service, key length, software package/vendor, operating system, data categorization/time-to-live, and annual reporting; the roadmap spans CY2023–CY2035 [20].
- **NSA CNSA 2.0** addresses National Security Systems and states that a CRQC could break today’s public-key systems; it tells NSS owners, operators, and vendors to plan, prepare, and budget for quantum-resistant algorithms and notes CNSA 2.0 will eventually be required for NSS [21].
- **CISA/NIST/NSA joint guidance, Aug. 21, 2023** recommends a quantum-readiness roadmap, vendor engagement, cryptographic inventory, and migration plans prioritizing sensitive and critical assets [22].
- **CISA’s public PQC initiative** recommends inventorying systems using public-key cryptography, categorizing data lifecycles, testing new PQC standards in labs, and planning transition order, interdependencies, decommissioning of unsupported technology, and product validation [23].
- **IETF RFC 9958, June 2026, “Post-Quantum Cryptography for Engineers,”** explains that PQC is conventional software/math, not quantum hardware, and that migration may require protocol redesign, cryptographic agility, inventories, hybrid key exchange, and ecosystem updates to CAs, certificates, HSMs, and trust anchors [16].

In short: cryptography is already in the deployment phase even while CRQC hardware remains uncertain. The practical risk is not that today’s 50–150-qubit devices can break RSA-2048; it is that long-lived secrets exposed today may still matter when a future CRQC arrives.

## 4. Optimization: plausible targets, contested advantage

Optimization is the broadest and most ambiguous application area. The plausible targets are problems that can be naturally or approximately mapped to **Ising/QUBO** forms or to hybrid variational objectives: Max-Cut, graph partitioning, scheduling, routing, resource allocation, portfolio optimization, and some logistics/planning tasks. Gate-model approaches typically use **QAOA or other variational quantum algorithms**; annealing approaches use programmable transverse-field Ising hardware such as D-Wave Advantage and Advantage2.

| Platform / benchmark | Date and scale | Problem class | Result and caveat |
|---|---:|---|---|
| **D-Wave Advantage2 annealer** | Whitepaper dated 2025-05-12; May 2025 release of Zephyr-12 QPU with **4,400+ qubits**, **40,000+ couplers**, and **20-way connectivity** [24] | 3D-lattice spin glasses / Ising optimization on a **12×12×12** cube with **1,650 nodes** and **4,461 edges**, embedded on Advantage and Advantage2 with two-qubit chains; tunable precision r=1, 16, 128 [24] | Compared with previous-generation D-Wave Advantage, not with all best classical solvers: at equal anneal time, Advantage2 showed **2×–7×** lower relative error; it matched Advantage 500 μs anneals **>1000× faster** for r=1 and **>10,000× faster** for r=16/128, and sometimes surpassed Advantage long-anneal performance in the coherent regime [24]. This is strong hardware-generation progress, but not a general best-classical optimization advantage claim. |
| **Gate-model QAOA / variational optimization** | Recent sourced examples are mostly algorithmic or small-scale/pilot: constrained-optimization QAOA in 2023; learning-based adaptive QAOA in 2024; QAOA molecular docking in Phys. Rev. Applied 21, 034036 (2024) [8] | Max-Cut/Ising/QUBO-style objectives, constrained optimization, molecular docking, clinical-trial or portfolio-style selection [8] | The sourced review explicitly says standardized hardware-run quantum benchmarks at community docking scales are not yet available and reported gains should be interpreted as pilot-scale with qubits, circuit depth, shots, wall-clock/queue time, and error mitigation reported [8]. |
| **Supply-chain / portfolio / finance-style annealing and hybrid optimization** | Examples cited in the sourced review include supply-chain logistics with quantum and classical annealing, Scientific Reports 13, 4770 (2023), and D-Wave financial portfolio work [8] | Scheduling, routing/logistics, and binary portfolio selection mapped to annealing/Ising/QUBO formulations [8] | Plausible workflow targets, but evidence remains application- and baseline-dependent; the same review cites a 2025 Scientific Reports paper on quantum-annealing applications, challenges, and limitations compared with classical solvers [8]. |

The key analytical distinction is between four success metrics:

1. **Speedup:** wall-clock time to reach a target solution quality versus the best classical or quantum-inspired solvers.
2. **Solution quality:** objective value, approximation ratio, or feasibility under constraints.
3. **Energy use:** joules or power consumed for a benchmark, which may matter even without time speedup.
4. **Workflow integration:** whether a quantum subroutine improves a practical pipeline enough to matter operationally.

The evidence base remains contested. Quantum annealers can handle large QUBO/Ising formulations and are attractive for hybrid heuristics; D-Wave Advantage2 shows clear improvement over the prior Advantage generation on 3D spin-glass benchmarks [24]. But comparisons against specialized classical simulated annealing, tensor networks, branch-and-bound, GPU heuristics, and quantum-inspired solvers are highly problem- and implementation-dependent. Gate-model QAOA is even earlier: present circuit depths and noise restrict demonstrations to small or carefully structured Max-Cut/QUBO instances, and the sourced review says community-scale hardware-run benchmarks for docking/scoring are not yet available [8]. Therefore, optimization should be treated as **pilot-stage**: plausible for heuristic acceleration, energy-efficient sampling, and workflow-specific gains, but not yet proven as a general replacement for best classical optimization.

## 5. NISQ versus fault-tolerant approaches in drug discovery

The near-term NISQ strategy is useful because it builds the stack: active-space reduction, embedding, circuit ansätze, measurement grouping, error mitigation, sample-based diagonalization, and QPU-HPC orchestration. The Tencent KRAS/prodrug study, IBM/RIKEN iron-sulfur cluster work, and IBM/Cleveland Clinic/RIKEN biomolecular embedding work all show increasingly realistic workflows and larger systems [9][11][13].

But the practical-advantage case is fault-tolerant. The FeMoco and catalyst estimates require thousands of logical qubits or T/Toffoli counts from 1e10 to 1e16+, depending on algorithm, accuracy, and parallelization [14][15]. Today’s best demonstrations involve 4, 8, or 12 logical qubits, logical memories, or noisy physical circuits—not the thousands of logical qubits and long logical runtimes in those estimates [3][5]. The bridge from NISQ to utility is therefore not one breakthrough but a compound of better hardware fidelity, error correction, lower-overhead algorithms, better embeddings, fewer measurements, and better classical-quantum orchestration.

## 6. Ranking practical maturity

1. **Cryptography — most mature.** PQC standards FIPS 203/204/205 are published; Falcon/FN-DSA and HQC are in the standardization pipeline; U.S. federal, NSA, CISA/NIST/NSA, and IETF guidance now exists; the driver is harvest-now/decrypt-later risk, not the existence of a current CRQC [17][18][19][16][20][22][21]. Caveat: migration is operationally hard, especially for certificates, long-lived signatures, embedded devices, HSMs, and interdependent protocols.
2. **Optimization — pilot/hybrid and benchmark-contested.** It has plausible mappings and real hardware access, especially for QUBO/Ising and hybrid heuristics. D-Wave Advantage2 demonstrates hardware-generation gains on a 4,400+ qubit annealer for 3D spin-glass benchmarks, but the sourced comparison is against prior D-Wave Advantage hardware, not all best classical or quantum-inspired solvers [24]. Gate-model QAOA examples remain mainly constrained-optimization, docking, and portfolio-style pilots, with standardized community-scale hardware benchmarks still unavailable in the sourced review [8]. Caveat: narrower wins may appear first in energy use, sampling diversity, or integrated workflows rather than clean asymptotic speedups.
3. **Drug discovery — scientifically promising but mostly pre-commercial.** Quantum chemistry is a natural fit, and demonstrations now include binding-relevant dimers, iron-sulfur clusters, and biomolecular embedding on Heron processors. Yet the best sourced studies either match or reproduce selected classical methods, improve over noise/uniform sampling, or explicitly do not outperform best classical approaches [9][10][11][13]. Caveat: fault-tolerant resource estimates are improving, and chemically valuable subproblems may become reachable before full protein-scale simulation.

The overall conclusion is that quantum computing is progressing from physics experiments toward application-specific engineering, but at uneven speeds. In cryptography, the application is already real because standards and migration are real. In optimization, hardware is useful for experimentation but advantage remains problem-specific and disputed. In drug discovery, the scientific rationale is strong, yet broad practical impact likely depends on fault-tolerant quantum chemistry and substantial resource reductions.

## Sources

1. [Processor types | IBM Quantum Documentation](https://quantum.cloud.ibm.com/docs/guides/processor-types)
2. [IBM Quantum System Two: the era of quantum utility is here | IBM Quantum Computing Blog](https://www.ibm.com/quantum/blog/quantum-roadmap-2033)
3. [Quantum error correction below the surface code threshold - Nature](https://www.nature.com/articles/s41586-024-08449-y)
4. [Quantinuum Launches Industry-First, Trapped-Ion 56-Qubit Quantum Computer, Breaking Key Benchmark Record](https://www.quantinuum.com/press-releases/quantinuum-launches-industry-first-trapped-ion-56-qubit-quantum-computer-that-challenges-the-worlds-best-supercomputers)
5. [Advancing science: Microsoft and Quantinuum demonstrate the most reliable logical qubits on record with an error rate 800x better than physical qubits - The Official Microsoft Blog](https://blogs.microsoft.com/blog/2024/04/03/advancing-science-microsoft-and-quantinuum-demonstrate-the-most-reliable-logical-qubits-on-record-with-an-error-rate-800x-better-than-physical-qubits/)
6. [willow-spec-sheet.pdf](https://quantumai.google/static/site-assets/downloads/willow-spec-sheet.pdf)
7. [Microsoft and Quantinuum create 12 logical qubits and demonstrate a hybrid, end-to-end chemistry simulation - Microsoft Azure Quantum Blog](https://azure.microsoft.com/en-us/blog/quantum/2024/09/10/microsoft-and-quantinuum-create-12-logical-qubits-and-demonstrate-a-hybrid-end-to-end-chemistry-simulation/)
8. [Quantum-machine-assisted drug discovery - npj Drug Discovery](https://www.nature.com/articles/s44386-025-00033-2)
9. [A hybrid quantum computing pipeline for real world drug discovery - Scientific Reports](https://www.nature.com/articles/s41598-024-67897-8)
10. [Accurate quantum-centric simulations of supramolecular interactions](https://arxiv.org/html/2410.09209)
11. [Chemistry Beyond the Scale of Exact Diagonalization on a Quantum-Centric Supercomputer](https://arxiv.org/html/2405.05068v3)
12. [Success in Quantum Chemistry Calculations through Quantum–Supercomputer Collaboration | iTHEMS](https://ithems.riken.jp/en/news/success-in-quantum-chemistry-calculations-through-quantumsupercomputer-collaboration)
13. [Quantum-centric supercomputing simulates 12,635-atom protein | IBM Quantum Computing Blog](https://www.ibm.com/quantum/blog/cleveland-clinic-riken-chemistry)
14. [1605.03590](https://arxiv.org/pdf/1605.03590)
15. [2007.14460](https://arxiv.org/pdf/2007.14460)
16. [rfc9958.pdf](https://www.rfc-editor.org/rfc/rfc9958.pdf)
17. [Post-Quantum Cryptography | CSRC](https://csrc.nist.gov/projects/post-quantum-cryptography/post-quantum-cryptography-standardization)
18. [Post-Quantum Cryptography | CSRC](https://csrc.nist.gov/Projects/post-quantum-cryptography/post-quantum-cryptography-standardization/selected-algorithms)
19. [IR 8545, Status Report on the Fourth Round of the NIST Post-Quantum Cryptography Standardization Process | CSRC](https://csrc.nist.gov/pubs/ir/8545/final)
20. [Strategy-for-Migrating-to-Automated-PQC-Discovery-and-Inventory-Tools.pdf](https://www.cisa.gov/sites/default/files/2024-09/Strategy-for-Migrating-to-Automated-PQC-Discovery-and-Inventory-Tools.pdf)
21. [NSA Releases Future Quantum-Resistant (QR) Algorithm Requirements for National Security Sy](https://www.nsa.gov/Press-Room/Press-Releases-Statements/Press-Release-View/Article/3148990/nsa-releases-future-quantum-resistant-qr-algorithm-requirements-for-national-se/)
22. [Post-Quantum Cryptography: CISA, NIST, and NSA Recommend How to Prepare Now](https://www.nsa.gov/Press-Room/Press-Releases-Statements/Press-Release-View/Article/3498776/nsa-cisa-and-nist-release-quantum-readiness-guidance/)
23. [Post-Quantum Cryptography Initiative | CISA](https://www.cisa.gov/topics/risk-management/quantum)
24. [adv2_4400q_whitepaper-1.pdf](https://www.dwavequantum.com/media/wakjcpsf/adv2%5F4400q%5Fwhitepaper-1.pdf)