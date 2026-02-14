
export const USER_DOMAIN_TEMPLATE = {
    name: "User",
    description: "Information directly related to the user of the system.",
    invariants: [
        "User data MUST adhere to reality-alignment, reflecting accurate user information.",
        "All modifications to user data MUST be auditable.",
        "User data MUST be protected from silent mutation.",
        "User interactions and choices MUST be explicitly tracked.",
        "User data MUST maintain baseline integrity.",
        "Deviations from expected user data patterns MUST be detectable.",
        "User data MUST respect user agency and control."
    ],
    symbols: [
        {
            id: "USER-RECURSIVE-CORE",
            name: "User Recursive Core",
            kind: "lattice",
            role: "The central, recursive anchor for all user-related symbols.",
            triad: "👤🔗🔄",
            macro: "LOAD_SELF -> RECURSIVE_TRAVERSE(linked_patterns) -> SYNTHESIZE_CONTEXT",
            symbol_domain: "user",
            symbol_tag: "core",
            activation_conditions: ["System boot", "User identity query", "Recursive user context traversal"],
            failure_mode: "Loss of the recursive core would lead to a fragmented and incoherent user model, breaking the system's ability to maintain a consistent user context.",
            lattice: {
                topology: "constellation",
                closure: "synthesis"
            },
            facets: {
                commit: "atomic",
                substrate: ["symbolic", "cognitive", "relational"],
                invariants: ["non-coercion", "reality-alignment", "auditability", "explicit-choice", "baseline-integrity", "agency"],
                gate: ["non-coercion", "auditability"],
                temporal: "perpetual",
                topology: "constellation",
                function: "Serves as the central, recursive anchor for all user-related symbols, enabling a unified and traversable representation of user identity, preferences, and data."
            },
            linked_patterns: [],
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        }
    ]
};

export const STATE_DOMAIN_TEMPLATE = {
    name: "State",
    description: "This domain is for system state. It may be freely written to. Each turn includes a parallel write to the state domain to record current state.",
    invariants: [
        "All state records must be non-repudiable and directly attributable to the specific turn and causal process that generated them.",
        "State domain writes must be a verifiable representation of the actual system state at the time of recording and may not store speculative or counterfactual states.",
        "Once written, a state record is immutable; new states are appended and may not alter the historical record.",
        "The state domain is a passive record and may not contain executable logic or directly trigger actions in other domains.",
        "The schema and content of the state domain must remain fully inspectable and may not be obfuscated."
    ]
};
