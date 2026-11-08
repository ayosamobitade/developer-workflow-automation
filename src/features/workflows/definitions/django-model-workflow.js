/**
 * Reusable Django model implementation workflow.
 *
 * Workflow:
 * 1. Create model
 * 2. Create model factory and model test
 * 3. Create selector
 * 4. Create selector test
 * 5. Create service
 * 6. Create service test
 *
 * Destinations are resolved against the actual project tree.
 * Explicit destination overrides always take priority.
 */

export const DJANGO_MODEL_WORKFLOW_ID = "django-model-workflow";

export const DJANGO_MODEL_WORKFLOW = {
    id: DJANGO_MODEL_WORKFLOW_ID,

    name: "Django Model Implementation",

    description:
        "Creates a Django model and its factory, tests, selector and service layers using deterministic model-path destination conventions.",

    version: 1,

    category: "django",

    settings: {
        executionMode: "sequential",

        stopOnError: true,

        requireOutputValidation: true,

        requireDestinationConfirmation: false,

        preserveOriginalSources: true,

        createBackupsBeforeWriting: true,
    },

    input: {
        modelPath: {
            type: "project_file",

            required: true,

            description:
                "The destination path for the Django model file.",
        },

        projectTree: {
            type: "project_tree",

            required: true,
        },
    },

    tasks: [
        {
            id: "create_model",

            name: "Create Model",

            description:
                "Generate the complete Django model implementation.",

            order: 1,

            dependencies: [],

            sources: [
                {
                    id: "project_tree",

                    type: "project_tree",

                    required: true,

                    preparation: {
                        mode: "full",
                    },
                },
            ],

            instruction:
                "Create the comprehensive Django model file for the selected model. Follow the supplied project structure, existing architectural conventions and relevant implementation requirements.",

            outputs: [
                {
                    id: "model",

                    name: "Model",

                    type: "python",

                    destination: {
                        mode: "explicit_input",

                        input: "modelPath",
                    },

                    required: true,

                    validation: {
                        extension: ".py",

                        nonEmpty: true,
                    },
                },
            ],
        },

        {
            id: "create_factory_and_model_test",

            name: "Create Model Factory and Model Test",

            description:
                "Generate the model factory and its corresponding model tests.",

            order: 2,

            dependencies: [
                "create_model",
            ],

            sources: [
                {
                    id: "model",

                    type: "workflow_output",

                    task: "create_model",

                    output: "model",

                    required: true,

                    preparation: {
                        mode: "configurable",

                        defaultMode: "full",

                        supportedModes: [
                            "full",
                            "remove_comments",
                            "remove_tests",
                            "remove_comments_and_tests",
                            "compact",
                        ],
                    },
                },
            ],

            instruction:
                "Using the supplied Django model, create two separate outputs: (1) a comprehensive factory_boy factory in <app_root>/tests/factories/<model_name>_factory.py, and (2) comprehensive model tests in <app_root>/tests/models/test_<model_name>.py. Use factory_boy (not Django's built-in TestCase fixtures or a hand-written factory). Follow the supplied model's fields, relationships, constraints and project conventions. Do not combine the two files.",

            outputs: [
                {
                    id: "model_factory",

                    name: "Model Factory",

                    type: "python",

                    destination: {
                        mode: "infer_from_project_tree",

                        requiresConfirmation: false,
                    },

                    required: true,

                    validation: {
                        extension: ".py",

                        nonEmpty: true,
                    },
                },

                {
                    id: "model_test",

                    name: "Model Test",

                    type: "python",

                    destination: {
                        mode: "infer_from_project_tree",

                        requiresConfirmation: false,
                    },

                    required: true,

                    validation: {
                        extension: ".py",

                        nonEmpty: true,
                    },
                },
            ],
        },

        {
            id: "create_selector",

            name: "Create Selector",

            description:
                "Generate the model's comprehensive selector layer.",

            order: 3,

            dependencies: [
                "create_model",
            ],

            sources: [
                {
                    id: "model",

                    type: "workflow_output",

                    task: "create_model",

                    output: "model",

                    required: true,

                    preparation: {
                        mode: "configurable",

                        defaultMode: "full",

                        supportedModes: [
                            "full",
                            "remove_comments",
                            "remove_tests",
                            "remove_comments_and_tests",
                            "compact",
                        ],
                    },
                },
            ],

            instruction:
                "Create the comprehensive Django selector for the supplied model. Save it at <app_root>/selectors/<model_group>/<model_name>_selector.py. Preserve the model's group directory structure. Follow the project's selector architecture and query optimization practices.",
                
            outputs: [
                {
                    id: "selector",

                    name: "Selector",

                    type: "python",

                    destination: {
                        mode: "infer_from_project_tree",

                        requiresConfirmation: false,
                    },

                    required: true,

                    validation: {
                        extension: ".py",

                        nonEmpty: true,
                    },
                },
            ],
        },

        {
            id: "create_selector_test",

            name: "Create Selector Test",

            description:
                "Generate tests for the selector implementation.",

            order: 4,

            dependencies: [
                "create_model",
                "create_selector",
            ],

            sources: [
                {
                    id: "model",

                    type: "workflow_output",

                    task: "create_model",

                    output: "model",

                    required: true,

                    preparation: {
                        mode: "configurable",

                        defaultMode: "full",

                        supportedModes: [
                            "full",
                            "remove_comments",
                            "remove_tests",
                            "remove_comments_and_tests",
                            "compact",
                            "model_contract",
                        ],
                    },
                },

                {
                    id: "selector",

                    type: "workflow_output",

                    task: "create_selector",

                    output: "selector",

                    required: true,

                    preparation: {
                        mode: "full",
                    },
                },
            ],

            instruction:
                "Create comprehensive tests for the supplied Django selector. Save them at <app_root>/tests/selectors/<model_group>/test_<model_name>_selector.py. Use the supplied model and selector implementations and preserve the model's group directory structure.",


            outputs: [
                {
                    id: "selector_test",

                    name: "Selector Test",

                    type: "python",

                    destination: {
                        mode: "infer_from_project_tree",

                        requiresConfirmation: false,
                    },

                    required: true,

                    validation: {
                        extension: ".py",

                        nonEmpty: true,
                    },
                },
            ],
        },

        {
            id: "create_service",

            name: "Create Service",

            description:
                "Generate the model's comprehensive service layer.",

            order: 5,

            dependencies: [
                "create_model",
                "create_selector",
            ],

            sources: [
                {
                    id: "model",

                    type: "workflow_output",

                    task: "create_model",

                    output: "model",

                    required: true,

                    preparation: {
                        mode: "configurable",

                        defaultMode: "full",

                        supportedModes: [
                            "full",
                            "remove_comments",
                            "remove_tests",
                            "remove_comments_and_tests",
                            "compact",
                        ],
                    },
                },

                {
                    id: "selector",

                    type: "workflow_output",

                    task: "create_selector",

                    output: "selector",

                    required: true,

                    preparation: {
                        mode: "full",
                    },
                },
            ],
          
            instruction:
                "Create the comprehensive Django service for the supplied model and selector. Save it at <app_root>/services/<model_group>/<model_name>_service.py. Preserve the model's group directory structure and follow the project's service architecture and business logic conventions.",

            outputs: [
                {
                    id: "service",

                    name: "Service",

                    type: "python",

                    destination: {
                        mode: "infer_from_project_tree",

                        requiresConfirmation: false,
                    },

                    required: true,

                    validation: {
                        extension: ".py",

                        nonEmpty: true,
                    },
                },
            ],
        },

        {
            id: "create_service_test",

            name: "Create Service Test",

            description:
                "Generate comprehensive tests for the service implementation.",

            order: 6,

            dependencies: [
                "create_model",
                "create_service",
            ],

            sources: [
                {
                    id: "service",

                    type: "workflow_output",

                    task: "create_service",

                    output: "service",

                    required: true,

                    preparation: {
                        mode: "full",
                    },
                },

                {
                    id: "model",

                    type: "workflow_output",

                    task: "create_model",

                    output: "model",

                    required: true,

                    preparation: {
                        mode: "configurable",

                        defaultMode: "full",

                        supportedModes: [
                            "full",
                            "remove_comments",
                            "remove_tests",
                            "remove_comments_and_tests",
                            "compact",
                        ],
                    },
                },
            ],

            instruction:
                "Create comprehensive tests for the supplied Django service. Save them at <app_root>/tests/services/<model_group>/test_<model_name>_service.py. Use the supplied service and model implementations and preserve the model's group directory structure.",

            outputs: [
                {
                    id: "service_test",

                    name: "Service Test",

                    type: "python",

                    destination: {
                        mode: "infer_from_project_tree",

                        requiresConfirmation: false,
                    },

                    required: true,

                    validation: {
                        extension: ".py",

                        nonEmpty: true,
                    },
                },
            ],
        },
    ],
};