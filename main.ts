import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, requestUrl, TFile, Menu, MenuItem, TFolder, TextAreaComponent, ButtonComponent, normalizePath } from 'obsidian';

// ----- CONSTANTS -----
const SUBPROCESSOR_URL_KEYWORDS = [
    'subprocessor', 'sub-processor', 'sub_processor',
    'vendor-list', 'vendorlist', 'third-party-list', 'thirdpartylist',
    'service-providers', 'serviceproviders',
    'dpa-exhibit', 'dpa/exhibit', 'data-processing-addendum/exhibit',
    'trust-center/sub', 'legal/subprocessors'
];


// ----- SETTINGS INTERFACE AND DEFAULTS -----
export interface LlmModel {
    id: string;
    alias: string;
  }

interface ProcessorProcessorSettings {
    serpApiKey: string;
    rightbrainClientId: string;
    rightbrainClientSecret: string;
    rightbrainOrgId: string;
    rightbrainProjectId: string;
    rightbrainApiUrl: string;
    rightbrainOauth2Url: string;
    rightbrainVerifyUrlTaskId: string;
    rightbrainExtractEntitiesTaskId: string;
    rightbrainExtractInputField: string;
    rightbrainExtractOutputThirdPartyField: string;
    rightbrainExtractOutputOwnEntitiesField: string;
    rightbrainDeduplicateSubprocessorsTaskId: string;
    rightbrainDuckDuckGoSearchTaskId: string;
    createPagesForOwnEntities: boolean;
    verboseDebug: boolean;
    maxResultsPerProcessor: number;
    maxRecursiveDepth: number;
    discoveryCacheDays: number;
    processorsFolderPath: string;
    analysisLogsFolderPath: string;
    rightbrainFindDpaTaskId: string;
    rightbrainFindTosTaskId: string; 
    rightbrainFindSecurityTaskId: string;
    autoSynchronizeTasks: boolean;
    llmModelList: LlmModel[];
    llmModelListLastUpdated: number;
    verifyUrlModelId: string;
    extractEntitiesModelId: string;
    deduplicateSubprocessorsModelId: string;
    duckDuckGoSearchModelId: string;
    findDpaModelId: string;
    findTosModelId: string;
    findSecurityModelId: string;
}

const DEFAULT_SETTINGS: ProcessorProcessorSettings = {
    serpApiKey: '',
    rightbrainClientId: '',
    rightbrainClientSecret: '',
    rightbrainOrgId: '',
    rightbrainProjectId: '',
    rightbrainApiUrl: 'https://app.rightbrain.ai/api/v1',
    rightbrainOauth2Url: 'https://oauth.rightbrain.ai',
    rightbrainVerifyUrlTaskId: '',
    rightbrainExtractEntitiesTaskId: '',
    rightbrainExtractInputField: 'page_text',
    rightbrainExtractOutputThirdPartyField: 'third_party_subprocessors',
    rightbrainExtractOutputOwnEntitiesField: 'own_entities',
    rightbrainDeduplicateSubprocessorsTaskId: '',
    rightbrainDuckDuckGoSearchTaskId: '',
    createPagesForOwnEntities: false,
    verboseDebug: false,
    maxResultsPerProcessor: 1,
    maxRecursiveDepth: 2,
    discoveryCacheDays: 30,
    processorsFolderPath: 'Processors',
    analysisLogsFolderPath: 'Analysis Logs',
    rightbrainFindDpaTaskId: '', 
    rightbrainFindTosTaskId: '', 
    rightbrainFindSecurityTaskId: '',
    autoSynchronizeTasks: true,
    llmModelList: [],
    llmModelListLastUpdated: 0,
    verifyUrlModelId: '', // We'll leave these blank and handle defaults in the UI
    extractEntitiesModelId: '',
    deduplicateSubprocessorsModelId: '',
    duckDuckGoSearchModelId: '',
    findDpaModelId: '',
    findTosModelId: '',
    findSecurityModelId: '',
}

// ----- DATA STRUCTURES -----
interface SerpApiResult {
    title: string; url: string; snippet: string; searchQuery?: string;
    processorName: string; documentType: string;
    sourceDpaUrl?: string;
}
interface ExtractedRelationship {
    PrimaryProcessor: string; SubprocessorName: string; ProcessingFunction: string;
    Location: string; RelationshipType: 'uses_subprocessor' | 'is_own_entity';
    SourceURL: string; VerificationReasoning: string;
}
interface ProcessedUrlInfo extends Partial<SerpApiResult> {
    url: string; title?: string; verificationMethod?: string; verificationReasoning?: string;
    isList?: boolean; isCurrent?: boolean; extractedSubprocessorsCount?: number; documentType: string;
}
interface SearchData {
    collectedRelationships: ExtractedRelationship[];
    processedUrlDetails: ProcessedUrlInfo[];
    flaggedCandidateUrlCount: number;
}

interface SubprocessorPageInfo {
    file_path: string;
    page_name: string;
    aliases: string[];
}

interface DeduplicationResultItem {
    survivor_file_path: string;
    duplicate_file_paths: string[];
    reasoning?: string;
}


// ----- MAIN PLUGIN CLASS -----
export default class ProcessorProcessorPlugin extends Plugin {
    settings: ProcessorProcessorSettings;
    private processedInCurrentRecursiveSearch: Set<string>;

    async onload() {
        this.processedInCurrentRecursiveSearch = new Set<string>();
        await this.loadSettings();
        
        this.updateLlmModelList(false); 

        if (this.settings.autoSynchronizeTasks) {
            setTimeout(() => this.synchronizeRightBrainTasks(), 1000); 
        }

        this.addRibbonIcon('link', 'Manually Add Subprocessor List URL', (evt: MouseEvent) => {
            new ManualInputModal(this.app, async (processorName, listUrl, isPrimary) => { // <-- Updated signature
                if (processorName && listUrl) {
                    new Notice(`Processing manual URL input for: ${processorName}`);
                    const processorFile = await this.ensureProcessorFile(processorName, true, isPrimary); // <-- Pass flag
                    if (processorFile) {
                        const searchData = await this.fetchDataFromDirectUrl(processorName, listUrl);
                        if (searchData) {
                            await this.persistSubprocessorInfo(processorName, processorFile, searchData, isPrimary); // <-- Pass flag
                            if (searchData.flaggedCandidateUrlCount > 0) {
                                new Notice(`${searchData.flaggedCandidateUrlCount} URL(s) looked promising but couldn't be verified. Check logs.`);
                            }
                        } else {
                            new Notice(`Could not process data from direct URL for ${processorName}.`);
                        }
                    } else {
                        new Notice(`Could not create or find file for ${processorName} in ${this.settings.processorsFolderPath}`);
                    }
                }
            }).open();
        });

        this.addRibbonIcon('paste', 'Input Subprocessor List from Text', (evt: MouseEvent) => {
            this.openManualTextEntryModal();
        });

        this.addCommand({
            id: 'run-processor-search-global',
            name: 'Search for Subprocessors (Discover)',
            callback: () => {
                new SearchModal(this.app, this.settings, async (processorName) => {
                    if (processorName) {
                        new Notice(`Starting discovery search for: ${processorName}`);
                        const processorFile = await this.ensureProcessorFile(processorName, true);
                        if (processorFile) {
                            await this.discoverAndProcessProcessorPage(processorName, processorFile);
                        } else {
                            new Notice(`Could not create or find file for ${processorName} in ${this.settings.processorsFolderPath}`);
                        }
                    }
                }).open();
            }
        });

        this.addCommand({
            id: 'input-subprocessor-list-from-text',
            name: 'Input Subprocessor List from Text',
            callback: () => {
                this.openManualTextEntryModal();
            }
        });

        this.addCommand({
            id: 'run-processor-search-recursive', // New ID
            name: 'Search for Subprocessors (Recursive Discover)',
            callback: () => {
                new SearchModal(this.app, this.settings, async (processorName) => {
                    if (processorName) {
                        // Optional: Add a way for the user to set maxDepth, or use a default/setting
                        await this.discoverRecursively(processorName, undefined, this.settings.maxRecursiveDepth);

                    }
                }).open();
            }
        });

        this.addCommand({
            id: 'force-merge-processors-from-palette',
            name: 'Force Merge processor files...',
            callback: () => {
                this.openFileSelectorMergeModal();
            }
        });

        this.addCommand({
            id: 'synchronize-rightbrain-tasks',
            name: 'Synchronize RightBrain Tasks',
            callback: () => {
                this.synchronizeRightBrainTasks();
            }
        });

        this.addCommand({
            id: 'complete-first-time-setup',
            name: 'Complete First-Time Setup (Credentials & Tasks)',
            callback: () => {
                new PasteEnvModal(this.app, this).open();
            }
        });

        this.addCommand({
            id: 'select-default-model',
            name: 'Select Default Model for All Tasks',
            callback: async () => {
                // First ensure we have the latest model list
                await this.updateLlmModelList(true);
                
                if (this.settings.llmModelList.length === 0) {
                    new Notice("No models available. Please check your RightBrain credentials and try again.");
                    return;
                }
                
                new ModelSelectionModal(
                    this.app,
                    this,
                    this.settings.llmModelList,
                    async (selectedModelId) => {
                        // Update all model settings to use the selected model
                        const modelSettingKeys = [
                            'verifyUrlModelId',
                            'extractEntitiesModelId', 
                            'deduplicateSubprocessorsModelId',
                            'duckDuckGoSearchModelId',
                            'findDpaModelId',
                            'findTosModelId',
                            'findSecurityModelId'
                        ];
                        
                        for (const key of modelSettingKeys) {
                            (this.settings as any)[key] = selectedModelId;
                        }
                        
                        await this.saveSettings();
                        new Notice(`All tasks will now use ${this.settings.llmModelList.find(m => m.id === selectedModelId)?.alias || selectedModelId}. Synchronizing with RightBrain...`);
                        
                        // Sync the changes to RightBrain
                        setTimeout(() => {
                            this.synchronizeRightBrainTasks();
                        }, 1000);
                    }
                ).open();
            }
        });

        this.addCommand({
            id: 'apply-recommended-graph-settings',
            name: 'Apply Recommended Graph Settings',
            callback: () => {
                this.applyRecommendedGraphSettings();
            }
        });

        this.registerEvent(
            this.app.workspace.on('file-menu', (menu: Menu, fileOrFolder: TFile | TFolder, source: string) => {
                
                // Logic for single folders
                if (fileOrFolder instanceof TFolder) {
                    const folder = fileOrFolder as TFolder;
                    if (folder.path === this.settings.processorsFolderPath) {
                        menu.addItem((item: MenuItem) => {
                            item.setTitle('Deduplicate Subprocessor Pages')
                                .setIcon('git-pull-request-draft')
                                .onClick(async () => {
                                    if (!this.settings.rightbrainDeduplicateSubprocessorsTaskId) {
                                        new Notice("Deduplication Task ID not set in plugin settings.");
                                        return;
                                    }
                                    new Notice(`Starting deduplication for folder: ${folder.path}`);
                                    await this.runDeduplicationForFolder(folder);
                                });
                        });
                    }
                } 
                // Logic for single files
                else if (fileOrFolder instanceof TFile && fileOrFolder.extension === 'md') {
                    const file = fileOrFolder as TFile;
                     if (file.path.startsWith(normalizePath(this.settings.processorsFolderPath) + "/")) {
                        const fileCache = this.app.metadataCache.getFileCache(file);
                        const frontmatter = fileCache?.frontmatter;
                        const originalProcessorName = (frontmatter?.aliases && Array.isArray(frontmatter.aliases) && frontmatter.aliases.length > 0)
                            ? frontmatter.aliases[0]
                            : file.basename;

                        menu.addItem((item: MenuItem) => {
                            item.setTitle('Map Subprocessor Relationships')
                                .setIcon('chevrons-down-up')
                                .onClick(async () => {
                                    new Notice(`Starting recursive discovery from: ${originalProcessorName}`);
                                    await this.discoverRecursively(originalProcessorName, file, this.settings.maxRecursiveDepth);
                                });
                        });

                        menu.addItem((item: MenuItem) => {
                            item.setTitle('Discover Subprocessor List').setIcon('wand')
                                .onClick(async () => {
                                    new Notice(`Discovering subprocessor list for: ${originalProcessorName}`);
                                    await this.discoverAndProcessProcessorPage(originalProcessorName, file);
                                });
                        });

                        menu.addItem((item: MenuItem) => {
                            item.setTitle('Enrich Processor Documentation')
                                .setIcon('book-plus')
                                .onClick(async () => {
                                    new Notice(`Enriching documentation for: ${originalProcessorName}`);
                                    await this.enrichProcessorFile(originalProcessorName, file);
                                });
                        });

                        menu.addItem((item: MenuItem) => {
                            item.setTitle('Add Subprocessor List URL').setIcon('plus-circle')
                                .onClick(async () => {
                                    new ManualInputModal(this.app, async (pName, listUrl, isPrimary) => {
                                        if (listUrl) {
                                            new Notice(`Processing manual URL input for: ${originalProcessorName} using URL: ${listUrl}`);
                                            const searchData = await this.fetchDataFromDirectUrl(originalProcessorName, listUrl);
                                            if (searchData) {
                                                await this.persistSubprocessorInfo(originalProcessorName, file, searchData, isPrimary);
                                                 if (searchData.flaggedCandidateUrlCount > 0) {
                                                    new Notice(`${searchData.flaggedCandidateUrlCount} URL(s) looked promising but couldn't be verified. Check logs.`);
                                                }
                                            } else {
                                                new Notice(`Could not process data from direct URL for ${originalProcessorName}.`);
                                            }
                                        }
                                    }, originalProcessorName).open();
                                });
                        });
                        
                        menu.addItem((item: MenuItem) => {
                            item.setTitle('Input Subprocessor List from Text').setIcon('file-input')
                                .onClick(async () => {
                                    this.openManualTextEntryModal(originalProcessorName);
                                });
                        });
                    }
                }
            })
        );

        this.addSettingTab(new ProcessorProcessorSettingTab(this.app, this));
        // Plugin loaded
    }

    onunload() {
        // Plugin unloaded
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    /**
     * Fetches the list of available LLM models from the Rightbrain API.
     * @returns A promise that resolves to an array of LlmModel objects.
     */
    async fetchLlmModels(): Promise<LlmModel[]> {
        const rbToken = await this.getRightBrainAccessToken();
        if (!rbToken) {
            console.error("Cannot fetch LLM models without an access token.");
            return [];
        }

        const modelsUrl = `${this.settings.rightbrainApiUrl}/org/${this.settings.rightbrainOrgId}/project/${this.settings.rightbrainProjectId}/model`;
        const headers = { 'Authorization': `Bearer ${rbToken}` };

        try {
            const response = await requestUrl({ url: modelsUrl, method: 'GET', headers: headers, throw: false });

            // FIX: Check if the response itself is an array
            if (response.status === 200 && Array.isArray(response.json)) {
                // FIX: Map over the response.json directly, not response.json.models
                return response.json.map((model: any) => ({
                    id: model.id,
                    alias: model.alias
                }));
            } else {
                console.error("Failed to list RightBrain LLM models:", response.status, response.text);
                return [];
            }
        } catch (error) {
            console.error("Error fetching RightBrain LLM models:", error);
            return [];
        }
    }

    /**
     * Updates the cached list of LLM models if the cache is stale or if forced.
     * @param force - If true, bypasses the cache check.
     */
    async updateLlmModelList(force = false): Promise<void> {
        const now = Date.now();
        const cacheDuration = 24 * 60 * 60 * 1000; // 24 hours

        const hasCredentials = this.settings.rightbrainClientId && this.settings.rightbrainOrgId && this.settings.rightbrainProjectId;

        if (!force && this.settings.llmModelList.length > 0 && (now - this.settings.llmModelListLastUpdated < cacheDuration)) {
            return; // Use cached data
        }

        if (!hasCredentials) {
            return; // Can't fetch without credentials.
        }

        try {
            const models = await this.fetchLlmModels();
            if (models.length > 0) {
                this.settings.llmModelList = models;
                this.settings.llmModelListLastUpdated = now;
                await this.saveSettings();
                if (force) {
                    new Notice('LLM model list has been updated.');
                }
            }
        } catch (error) {
            console.error("Failed to update LLM model list:", error);
            if (force) {
                new Notice('Failed to update LLM model list. Check console.');
            }
        }
    }

    private openManualTextEntryModal(initialProcessorName?: string) {
        if (!this.settings.rightbrainExtractEntitiesTaskId) {
            new Notice("RightBrain Task ID for entity extraction is not configured. Please set it in plugin settings.");
            return;
        }
        new ManualTextEntryModal(this.app, async (processorName, pastedText, isPrimary) => { 
            if (processorName && pastedText) {
                new Notice(`Processing pasted text for: ${processorName}`);
                // Pass the 'isPrimary' flag to ensure the correct tag is applied
                const processorFile = await this.ensureProcessorFile(processorName, true, isPrimary);
                if (processorFile) {
                    const searchData = await this.fetchDataFromPastedText(processorName, pastedText);
                    if (searchData) {
                        // Pass the 'isPrimary' flag here as well for consistency
                        await this.persistSubprocessorInfo(processorName, processorFile, searchData, isPrimary);
                    } else {
                        new Notice(`Could not process data from pasted text for ${processorName}.`);
                    }
                } else {
                    new Notice(`Could not create or find file for ${processorName} in ${this.settings.processorsFolderPath}`);
                }
            }
        }, initialProcessorName).open();
    }

    private sanitizeNameForFilePathAndAlias(entityName: string | undefined | null): { filePathName: string, originalNameAsAlias: string } {
        const originalName = (entityName || "Unknown Entity").trim();
        let baseNameForFile = originalName;

        // Check for "dba" patterns to prioritize the "doing business as" name for the file
        const dbaRegex = /^(.*?)\s+(?:dba|d\/b\/a|doing business as)\s+(.*)$/i;
        const dbaMatch = originalName.match(dbaRegex);
        if (dbaMatch && dbaMatch[2]) { // dbaMatch[2] is the name after 'dba'
            baseNameForFile = dbaMatch[2].trim(); // Use this as the base for the filename
        }

        // Remove commas from the base name for the file, as they can be problematic in links/tags
        let filePathName = baseNameForFile.replace(/,/g, '');
        // Replace characters forbidden in file paths
        filePathName = filePathName.replace(/[\\/:*?"<>|]/g, '').trim();

        // If filePathName becomes empty after sanitization (e.g., name was just "///"),
        // use a sanitized version of the original full name or a fallback.
        if (!filePathName) {
            filePathName = originalName.replace(/[\\/:*?"<>|,]/g, '').replace(/\s+/g, '_') || "Sanitized_Entity";
        }
         if (!filePathName) { // Final fallback if it's still somehow empty
            filePathName = "Sanitized_Entity_" + Date.now();
        }

        return {
            filePathName: filePathName,
            originalNameAsAlias: originalName // The original full name is always used as an alias
        };
    }


    private scrubHyperlinks(text: string | undefined | null): string {
        if (!text) return "N/A"; // Return "N/A" if input is null, undefined, or empty
        let scrubbedText = String(text); // Ensure it's a string

        // Remove Markdown links: [link text](url) -> link text
        scrubbedText = scrubbedText.replace(/\[(.*?)\]\((?:.*?)\)/g, '$1');
        // Remove HTML links: <a href="...">link text</a> -> link text
        scrubbedText = scrubbedText.replace(/<a[^>]*>(.*?)<\/a>/gi, '$1');
        // Strip any remaining HTML tags
        scrubbedText = scrubbedText.replace(/<[^>]+>/g, '');
        // Normalize whitespace (multiple spaces/newlines to single space)
        scrubbedText = scrubbedText.replace(/\s+/g, ' ').trim();

        return scrubbedText || "N/A"; // Return "N/A" if the result is an empty string
    }


    private addRelationship(
        collectedRelationships: ExtractedRelationship[],
        seenRelationships: Set<string>, // To track unique (PrimaryProcessor, SubprocessorName, Type) tuples
        processorName: string,          // The name of the primary processor this relationship pertains to
        entity: any,                    // The raw entity object (e.g., from RightBrain)
        type: ExtractedRelationship['RelationshipType'], // 'uses_subprocessor' or 'is_own_entity'
        sourceUrl: string,              // The URL where this information was found/verified
        verificationReasoning: string | undefined | null // Reasoning from verification, if any
    ): number { // Returns 1 if a new relationship was added, 0 otherwise

        const originalEntityName = entity.name?.trim();
        if (!originalEntityName) return 0; // Skip if no name

        // Use the original, unaltered entity name for storage and comparison
        // The sanitization for file paths will happen later when creating files.
        const subprocessorNameToStore = originalEntityName;

        // Special handling for OpenAI - skip if it's identifying its own known affiliates as "own_entity"
        // This prevents OpenAI from listing itself or its core components as if they were distinct subprocessors *of itself*.
        if (processorName.toLowerCase() === "openai" && type === "is_own_entity") {
            const openaiAffiliates = ["openai global", "openai, opco", "openai ireland", "openai uk", "openai japan", "openaiglobal", "openai opco", "openai llc"];
            // If the entity name looks like one of OpenAI's own common names/affiliates, don't add it as an "own_entity" relationship for OpenAI.
            if (openaiAffiliates.some(aff => originalEntityName.toLowerCase().includes(aff)) || originalEntityName.toLowerCase() === "openai") {
                // if (this.settings.verboseDebug) console.log(`Skipping adding '${originalEntityName}' as own_entity for OpenAI due to self-reference/affiliate rule.`);
                return 0;
            }
        }


        // Create a unique tuple for this relationship to avoid duplicates *within the current processing run*
        const relTuple = `${processorName}|${subprocessorNameToStore}|${type}`;

        if (!seenRelationships.has(relTuple)) {
            collectedRelationships.push({
                PrimaryProcessor: processorName,
                SubprocessorName: subprocessorNameToStore, // Store the original name
                ProcessingFunction: this.scrubHyperlinks(entity.processing_function),
                Location: this.scrubHyperlinks(entity.location),
                RelationshipType: type,
                SourceURL: sourceUrl,
                VerificationReasoning: this.scrubHyperlinks(verificationReasoning)
            });
            seenRelationships.add(relTuple);
            return 1;
        }
        return 0;
    }


    async discoverAndProcessProcessorPage(processorName: string, processorFile: TFile) {
        new Notice(`Processing (discovery): ${processorName}...`);
        const searchData = await this.fetchProcessorSearchDataWithDiscovery(processorName);

        if (searchData) {
            await this.persistSubprocessorInfo(processorName, processorFile, searchData);
            if (searchData.flaggedCandidateUrlCount > 0) {
                new Notice(`${searchData.flaggedCandidateUrlCount} URL(s) looked promising but couldn't be verified. Check Analysis Log for details and consider using the 'Input from Text' feature.`);
            }
        } else {
            new Notice(`Failed to fetch data via discovery for ${processorName}.`);
        }
    }

    async enrichProcessorFile(processorName: string, file: TFile) {
        new Notice(`Fetching compliance documents for ${processorName}...`, 5000);
        const rbToken = await this.getRightBrainAccessToken();
        if (!rbToken) {
            new Notice("Failed to get RightBrain token. Aborting enrichment.");
            return;
        }

        const documentTypes = [
            { type: 'DPA', taskId: this.settings.rightbrainFindDpaTaskId, title: "Data Processing Agreement" },
            { type: 'ToS', taskId: this.settings.rightbrainFindTosTaskId, title: "Terms of Service" },
            { type: 'Security', taskId: this.settings.rightbrainFindSecurityTaskId, title: "Security Documentation" }
        ];

        const foundDocuments: { title: string, url: string }[] = [];

        for (const doc of documentTypes) {
            if (!doc.taskId) {
                if (this.settings.verboseDebug) console.log(`Skipping ${doc.type} search for ${processorName}, no Task ID set.`);
                continue;
            }

            const taskInputPayload = { "company_name": processorName };
            const taskResult = await this.callRightBrainTask(doc.taskId, taskInputPayload, rbToken);

            // Assuming the RightBrain task returns a simple { "url": "..." } object
            if (taskResult?.response?.url && this.isValidUrl(taskResult.response.url)) {
                foundDocuments.push({ title: doc.title, url: taskResult.response.url });
                if (this.settings.verboseDebug) console.log(`Found ${doc.type} for ${processorName}: ${taskResult.response.url}`);
            } else {
                if (this.settings.verboseDebug) console.warn(`Could not find valid URL for ${doc.type} for ${processorName}. Result:`, taskResult);
            }
            await new Promise(resolve => setTimeout(resolve, 500)); // Small delay between tasks
        }

        if (foundDocuments.length === 0) {
            new Notice(`No new compliance documents found for ${processorName}.`);
            return;
        }

        // Format the results into a markdown list
        let markdownContent = "\n"; // Start with a newline to ensure separation
        foundDocuments.forEach(doc => {
            markdownContent += `- **${doc.title}:** [${doc.url}](${doc.url})\n`;
        });

        // Use ensureHeadingAndSection to append to the file
        const heading = "Compliance Documentation";
        await this.app.vault.process(file, (content: string) => {
            // The 'true' at the end tells the function to append under the heading if it already exists.
            // This prevents creating duplicate sections if you run enrichment multiple times.
            return this.ensureHeadingAndSection(content, heading, markdownContent, null, null, true);
        });

        new Notice(`Successfully added ${foundDocuments.length} document link(s) to ${processorName}.`);
    }

    async synchronizeRightBrainTasks() {
        new Notice("Starting RightBrain task synchronization...", 4000);
    
        const creds = {
            apiUrl: this.settings.rightbrainApiUrl,
            oauthUrl: this.settings.rightbrainOauth2Url,
            clientId: this.settings.rightbrainClientId,
            clientSecret: this.settings.rightbrainClientSecret,
            orgId: this.settings.rightbrainOrgId,
            projectId: this.settings.rightbrainProjectId
        };
    
        const rbToken = await this.getRightBrainAccessToken(creds);
        if (!rbToken) {
            new Notice("Task sync failed: Could not get RightBrain Access Token.", 10000);
            return;
        }
    
        let localTaskDefs: any[];
        try {
            const adapter = this.app.vault.adapter;
            const filePath = `${this.manifest.dir}/task_definitions.json`;
            if (!(await adapter.exists(filePath))) {
                new Notice("Task sync failed: task_definitions.json not found.", 10000);
                return;
            }
            localTaskDefs = JSON.parse(await adapter.read(filePath));
        } catch (error) {
            new Notice("Task sync failed: Could not read task_definitions.json. Check console.", 10000);
            console.error("ProcessorProcessor: Failed to load local task definitions:", error);
            return;
        }
    
        const serverTasksArray = await this.listAllRightBrainTasks(rbToken, creds);
        if (serverTasksArray === null) {
            new Notice("Task sync failed: Could not retrieve tasks from RightBrain.", 10000);
            return;
        }
        const serverTasksMap = new Map(serverTasksArray.map((task: any) => [task.name, task]));
    
        for (const localDef of localTaskDefs) {
            const serverTask = serverTasksMap.get(localDef.name);
    
            const modelSettingKeyMap: { [key: string]: keyof ProcessorProcessorSettings } = {
                'rightbrainVerifyUrlTaskId': 'verifyUrlModelId',
                'rightbrainExtractEntitiesTaskId': 'extractEntitiesModelId',
                'rightbrainDeduplicateSubprocessorsTaskId': 'deduplicateSubprocessorsModelId',
                'rightbrainDuckDuckGoSearchTaskId': 'duckDuckGoSearchModelId',
                'rightbrainFindDpaTaskId': 'findDpaModelId',
                'rightbrainFindTosTaskId': 'findTosModelId',
                'rightbrainFindSecurityTaskId': 'findSecurityModelId'
            };
            const modelSettingKey = modelSettingKeyMap[localDef.setting_key];
            const userSelectedModelId = modelSettingKey ? (this.settings as any)[modelSettingKey] : null;

            if (this.settings.verboseDebug) {
                console.log(`Task '${localDef.name}': Setting key: ${modelSettingKey}, User selected model: ${userSelectedModelId}, Default model: ${localDef.llm_model_id}`);
            }

            // Create a clean payload with only the properties needed for a revision.
            const newRevisionPayload: any = {
                system_prompt: localDef.system_prompt,
                user_prompt: localDef.user_prompt,
                output_format: localDef.output_format,
                input_processors: localDef.input_processors || [],
                enabled: localDef.enabled,
                llm_model_id: userSelectedModelId || localDef.llm_model_id || null
            };
    
            if (!serverTask) {
                if (this.settings.verboseDebug) console.log(`Task '${localDef.name}' not found on server. Creating...`);
                const createTaskPayload = { ...newRevisionPayload, name: localDef.name, description: localDef.description };
                await this.createRightBrainTask(rbToken, createTaskPayload, creds);
            } else {
                if (this.settings.verboseDebug) {
                    console.log(`Server task structure for '${localDef.name}':`, JSON.stringify(serverTask, null, 2));
                }
                // Try both possible field names for revisions
                const revisions = serverTask.task_revisions || serverTask.revisions;
                const latestRevision = revisions?.sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
                
                const needsUpdate = !latestRevision ||
                                    latestRevision.system_prompt !== newRevisionPayload.system_prompt ||
                                    latestRevision.user_prompt !== newRevisionPayload.user_prompt ||
                                    latestRevision.llm_model_id !== newRevisionPayload.llm_model_id ||
                                    JSON.stringify(latestRevision.output_format) !== JSON.stringify(newRevisionPayload.output_format);

                if (this.settings.verboseDebug) {
                    console.log(`Task '${localDef.name}': Current model: ${latestRevision?.llm_model_id}, New model: ${newRevisionPayload.llm_model_id}, Needs update: ${needsUpdate}`);
                    if (latestRevision?.llm_model_id !== newRevisionPayload.llm_model_id) {
                        console.log(`Model change detected for '${localDef.name}': ${latestRevision?.llm_model_id} -> ${newRevisionPayload.llm_model_id}`);
                    }
                }
    
                if (needsUpdate) {
                    if (this.settings.verboseDebug) console.log(`Task '${localDef.name}' has updates. Creating new revision...`);
                    await this.updateRightBrainTask(rbToken, serverTask.id, newRevisionPayload, localDef.name, creds);
                }
            }
        }
    
        const finalServerTasks = await this.listAllRightBrainTasks(rbToken, creds);
        if (finalServerTasks === null) {
            new Notice("Task sync failed: Could not fetch final task list to save IDs.", 10000);
            return;
        }
        const finalTaskMap = new Map(finalServerTasks.map((task: any) => [task.name, task.id]));
    
        let tasksPopulated = 0;
        for (const localDef of localTaskDefs) {
            const settingKey = localDef.setting_key as keyof ProcessorProcessorSettings;
            if (settingKey && finalTaskMap.has(localDef.name)) {
                (this.settings as any)[settingKey] = finalTaskMap.get(localDef.name);
                tasksPopulated++;
            }
        }
    
        await this.saveSettings();
        new Notice(`RightBrain tasks synchronized successfully. ${tasksPopulated} tasks configured.`, 10000);
    }

    async setupRightBrainTasksWithModel(creds: { apiUrl: string, oauthUrl: string, clientId: string, clientSecret: string, orgId: string, projectId: string }, defaultModelId: string) {
        new Notice("Step 1: Verifying tasks on RightBrain...", 4000);

        // Get auth token and load local definitions from the JSON file
        const rbToken = await this.getRightBrainAccessToken(creds);
        if (!rbToken) {
            new Notice("Setup failed: Could not get RightBrain Access Token.");
            return;
        }

        let taskDefs: any[]; // Using 'any[]' to easily access the custom 'setting_key' property
        try {
            const adapter = this.app.vault.adapter;
            const pluginDir = this.manifest.dir;
            const filePath = `${pluginDir}/task_definitions.json`;
            if (!(await adapter.exists(filePath))) {
                new Notice("Error: task_definitions.json not found in plugin folder.", 7000);
                return;
            }
            const fileContent = await adapter.read(filePath);
            taskDefs = JSON.parse(fileContent);
        } catch (error) {
            new Notice("Error reading or parsing task_definitions.json. Check console.", 7000);
            console.error("ProcessorProcessor: Failed to load task definitions from file:", error);
            return;
        }

        // --- Step 1: Ensure all tasks from definitions exist on the server, creating any that are missing ---
        const existingTasks = await this.listAllRightBrainTasks(rbToken, creds);
        if (existingTasks === null) {
            new Notice("Setup failed: Could not retrieve existing tasks from RightBrain.");
            return;
        }
        const existingTaskNames = new Set(existingTasks.map((task: any) => task.name));

        for (const taskDef of taskDefs) {
            if (!existingTaskNames.has(taskDef.name)) {
                new Notice(`Creating missing task: '${taskDef.name}'...`);
                // Add the selected model to the task definition
                const taskDefWithModel = { ...taskDef, llm_model_id: defaultModelId };
                await this.createRightBrainTask(rbToken, taskDefWithModel, creds);
                await new Promise(resolve => setTimeout(resolve, 500)); // Pause to prevent rate-limiting
            }
        }

        // --- Step 2: Re-fetch the complete list of tasks to get definitive IDs ---
        new Notice("Step 2: Fetching all task IDs...", 4000);
        const allServerTasks = await this.listAllRightBrainTasks(rbToken, creds);
        if (allServerTasks === null) {
            new Notice("Error: Could not fetch the final list of tasks to save their IDs.");
            return;
        }

        // --- Step 3: Create a map of Task Name -> Task ID for easy lookup ---
        const serverTaskMap = new Map(allServerTasks.map((task: any) => [task.name, task.id]));
        let tasksPopulated = 0;

        // --- Step 4: Loop through local definitions and populate settings using the map ---
        for (const taskDef of taskDefs) {
            const settingKey = taskDef.setting_key as keyof ProcessorProcessorSettings;
            if (settingKey && serverTaskMap.has(taskDef.name)) {
                const taskId = serverTaskMap.get(taskDef.name);
                if (taskId) {
                    (this.settings as any)[settingKey] = taskId;
                    tasksPopulated++;
                }
            } else {
                console.warn(`Could not find a matching task on the server for local definition: "${taskDef.name}"`);
            }
        }
        
        // --- Step 5: Save the fully populated settings object to data.json ---
        await this.saveSettings();
        
        if (tasksPopulated === taskDefs.length) {
            new Notice(`Success! All ${tasksPopulated} task IDs have been configured and saved.`);
        } else {
            new Notice(`Setup finished, but only ${tasksPopulated} of ${taskDefs.length} task IDs could be saved.`);
        }
    }

    async setupRightBrainTasks(creds: { apiUrl: string, oauthUrl: string, clientId: string, clientSecret: string, orgId: string, projectId: string }) {
        new Notice("Step 1: Verifying tasks on RightBrain...", 4000);

        // Get auth token and load local definitions from the JSON file
        const rbToken = await this.getRightBrainAccessToken(creds);
        if (!rbToken) {
            new Notice("Setup failed: Could not get RightBrain Access Token.");
            return;
        }

        let taskDefs: any[]; // Using 'any[]' to easily access the custom 'setting_key' property
        try {
            const adapter = this.app.vault.adapter;
            const pluginDir = this.manifest.dir;
            const filePath = `${pluginDir}/task_definitions.json`;
            if (!(await adapter.exists(filePath))) {
                new Notice("Error: task_definitions.json not found in plugin folder.", 7000);
                return;
            }
            const fileContent = await adapter.read(filePath);
            taskDefs = JSON.parse(fileContent);
        } catch (error) {
            new Notice("Error reading or parsing task_definitions.json. Check console.", 7000);
            console.error("ProcessorProcessor: Failed to load task definitions from file:", error);
            return;
        }

        // --- Step 1: Ensure all tasks from definitions exist on the server, creating any that are missing ---
        const existingTasks = await this.listAllRightBrainTasks(rbToken, creds);
        if (existingTasks === null) {
            new Notice("Setup failed: Could not retrieve existing tasks from RightBrain.");
            return;
        }
        const existingTaskNames = new Set(existingTasks.map((task: any) => task.name));

        for (const taskDef of taskDefs) {
            if (!existingTaskNames.has(taskDef.name)) {
                new Notice(`Creating missing task: '${taskDef.name}'...`);
                await this.createRightBrainTask(rbToken, taskDef, creds);
                await new Promise(resolve => setTimeout(resolve, 500)); // Pause to prevent rate-limiting
            }
        }

        // --- Step 2: Re-fetch the complete list of tasks to get definitive IDs ---
        new Notice("Step 2: Fetching all task IDs...", 4000);
        const allServerTasks = await this.listAllRightBrainTasks(rbToken, creds);
        if (allServerTasks === null) {
            new Notice("Error: Could not fetch the final list of tasks to save their IDs.");
            return;
        }

        // --- Step 3: Create a map of Task Name -> Task ID for easy lookup ---
        const serverTaskMap = new Map(allServerTasks.map((task: any) => [task.name, task.id]));
        let tasksPopulated = 0;

        // --- Step 4: Loop through local definitions and populate settings using the map ---
        for (const taskDef of taskDefs) {
            const settingKey = taskDef.setting_key as keyof ProcessorProcessorSettings;
            if (settingKey && serverTaskMap.has(taskDef.name)) {
                const taskId = serverTaskMap.get(taskDef.name);
                if (taskId) {
                    (this.settings as any)[settingKey] = taskId;
                    tasksPopulated++;
                }
            } else {
                console.warn(`Could not find a matching task on the server for local definition: "${taskDef.name}"`);
            }
        }
        
        // --- Step 5: Save the fully populated settings object to data.json ---
        await this.saveSettings();
        
        if (tasksPopulated === taskDefs.length) {
            new Notice(`Success! All ${tasksPopulated} task IDs have been configured and saved.`);
        } else {
            new Notice(`Setup finished, but only ${tasksPopulated} of ${taskDefs.length} task IDs could be saved.`);
        }
    }
    
    /**
     * Fetches a list of all tasks from the configured RightBrain project.
     * @param rbToken The RightBrain access token.
     * @returns An array of task objects or null if an error occurs.
     */
    async listAllRightBrainTasks(rbToken: string, creds: { apiUrl: string, orgId: string, projectId: string }): Promise<any[] | null> {
        // This function now uses the 'creds' object to build the URL
        const tasksUrl = `${creds.apiUrl}/org/${creds.orgId}/project/${creds.projectId}/task`;
        const headers = { 'Authorization': `Bearer ${rbToken}` };

        try {
            const response = await requestUrl({ url: tasksUrl, method: 'GET', headers: headers, throw: false });
            if (response.status === 200) {
                return response.json.results || [];
            } else {
                console.error("Failed to list RightBrain tasks:", response.status, response.text);
                return null;
            }
        } catch (error) {
            console.error("Error fetching RightBrain tasks:", error);
            return null;
        }
    }
    
    /**
     * Creates a single new task in RightBrain using a provided definition.
     * @param rbToken The RightBrain access token.
     * @param taskDefinition An object containing the full configuration for the new task.
     * @returns The created task object or null if an error occurs.
     */
    private async createRightBrainTask(rbToken: string, taskDefinition: any, creds: { apiUrl: string, orgId: string, projectId: string }): Promise<any | null> {
        // This function also uses the 'creds' object now
        const createUrl = `${creds.apiUrl}/org/${creds.orgId}/project/${creds.projectId}/task`;
        const headers = {
            'Authorization': `Bearer ${rbToken}`,
            'Content-Type': 'application/json'
        };

        try {
            const response = await requestUrl({
                url: createUrl,
                method: 'POST',
                headers: headers,
                body: JSON.stringify(taskDefinition),
                throw: false
            });

            if (response.status === 201 || response.status === 200) {
                new Notice(`Successfully created task: '${taskDefinition.name}'`);
                return response.json;
            } else {
                new Notice(`Failed to create task '${taskDefinition.name}': ${response.status}`, 7000);
                console.error(`Error creating task '${taskDefinition.name}':`, response.status, response.text);
                return null;
            }
        } catch (error) {
            console.error(`Network error creating task '${taskDefinition.name}':`, error);
            return null;
        }
    }

    async persistSubprocessorInfo(processorName: string, processorFile: TFile, searchData: SearchData, isTopLevelProcessor = true, mergeDecisions: string[] = []) {
        new Notice(`Persisting info for: ${processorName}...`);
        await this.ensureFolderExists(this.settings.processorsFolderPath);
        await this.ensureFolderExists(this.settings.analysisLogsFolderPath);

        const { collectedRelationships, processedUrlDetails } = searchData;

        // Update the main processor file (e.g., "OpenAI.md")
        await this.updateProcessorFile(processorFile, processorName, collectedRelationships, isTopLevelProcessor);

        // Get unique target entity names (subprocessors or own_entities)
        const uniqueTargetEntityOriginalNames = Array.from(new Set(collectedRelationships.map(r => r.SubprocessorName)));
        const createdPagesForThisRun = new Set<string>(); // Track file paths created/updated in this run to avoid redundant ops

        for (const targetEntityOriginalName of uniqueTargetEntityOriginalNames) {
            const { filePathName: targetEntityFilePathName } = this.sanitizeNameForFilePathAndAlias(targetEntityOriginalName);

            if (createdPagesForThisRun.has(targetEntityFilePathName)) {
                // if (this.settings.verboseDebug) console.log(`Already processed page for ${targetEntityFilePathName} in this run, skipping.`);
                continue;
            }

            // Get all relationships where this entity is the target (SubprocessorName)
            const relationsWhereThisEntityIsTarget = collectedRelationships.filter(r => r.SubprocessorName === targetEntityOriginalName);

            if (relationsWhereThisEntityIsTarget.length === 0) {
                // if (this.settings.verboseDebug) console.log(`No relationships found for target ${targetEntityOriginalName}, skipping page creation.`);
                continue; // Should not happen if it's in uniqueTargetEntityOriginalNames from collectedRelationships
            }

            // Determine if this entity is ever used as a subprocessor by *any* primary processor in the current batch
            const isEverUsedAsSubprocessor = relationsWhereThisEntityIsTarget.some(r => r.RelationshipType === 'uses_subprocessor');

            // Determine if this entity is an "own_entity" of the *current* primary processor being processed (processorName)
            const isOwnEntityOfCurrentPrimaryProcessor = relationsWhereThisEntityIsTarget.some(
                r => r.PrimaryProcessor === processorName && r.RelationshipType === 'is_own_entity'
            );

            let shouldCreatePage = false;
            if (isEverUsedAsSubprocessor) {
                shouldCreatePage = true; // Always create/update page if it's a subprocessor
                // if (this.settings.verboseDebug) console.log(`Page for '${targetEntityOriginalName}' will be created/updated because it's used as a subprocessor.`);
            } else if (isOwnEntityOfCurrentPrimaryProcessor) {
                // If it's an own_entity of the current processor, create page only if setting is enabled
                if (this.settings.createPagesForOwnEntities) {
                    shouldCreatePage = true;
                    // if (this.settings.verboseDebug) console.log(`Page for own_entity '${targetEntityOriginalName}' (of '${processorName}') will be created/updated due to setting.`);
                } else {
                    // if (this.settings.verboseDebug) console.log(`Skipping page creation for own_entity '${targetEntityOriginalName}' (of '${processorName}') due to setting.`);
                }
            }


            if (shouldCreatePage) {
                // When creating/updating a subprocessor's page (e.g., "AWS.md"),
                // we list all primary processors that use it as a subprocessor.
                const clientRelationshipsForTargetEntityPage = collectedRelationships.filter(
                    r => r.SubprocessorName === targetEntityOriginalName && r.RelationshipType === 'uses_subprocessor'
                );

                await this.createOrUpdateSubprocessorFile(
                    targetEntityOriginalName,        // The name of the subprocessor/own_entity itself
                    processorName,                   // The primary processor context (for logging/tracking, not for content of subprocessor's page directly)
                    clientRelationshipsForTargetEntityPage // Relationships where this entity is the subprocessor
                );
                createdPagesForThisRun.add(targetEntityFilePathName);
            }
        }

        // Update the analysis log for the primary processor
        await this.updateAnalysisLogPage(processorName, processedUrlDetails, collectedRelationships, mergeDecisions);
        new Notice(`Finished persisting info for ${processorName}.`);
    }

    async searchViaRightBrainDuckDuckGo(processorName: string, rbToken: string): Promise<SerpApiResult[]> {
        // The logic to create the task on the fly has been removed.
        // We now just check if the setting is present.
        if (!this.settings.rightbrainDuckDuckGoSearchTaskId) {
            new Notice("DuckDuckGo Search Task ID is not configured. Please run the setup command or configure it in settings.", 10000);
            return []; // Fail gracefully if the task ID is not set
        }
    
        const searchTaskId = this.settings.rightbrainDuckDuckGoSearchTaskId;
    
        const searchQueries = this.generateSearchQueries(processorName);
        const allResults: SerpApiResult[] = [];
        const queriesToProcess = searchQueries.slice(0, Math.min(searchQueries.length, 2));
    
        new Notice(`Performing up to ${queriesToProcess.length} DuckDuckGo searches for ${processorName}...`, 5000);
    
        for (const query of queriesToProcess) {
            const duckDuckGoUrl = `https://duckduckgo.com/?q=${encodeURIComponent(query)}&ia=web&kl=us-en&kp=-2`;
    
            const taskInputPayload = {
                search_url_to_process: duckDuckGoUrl,
                target_company_name: processorName
            };
    
            if (this.settings.verboseDebug) {
                console.log(`Calling RightBrain Task ${searchTaskId} for DDG search. URL: ${duckDuckGoUrl}, Target: ${processorName}`);
            }
    
            const taskRunResult = await this.callRightBrainTask(searchTaskId, taskInputPayload, rbToken);
    
            if (this.settings.verboseDebug && taskRunResult) {
                console.log(`Full RightBrain Response for DDG search query "${query}":`, JSON.stringify(taskRunResult, null, 2));
            }
    
            if (taskRunResult?.response?.search_results && Array.isArray(taskRunResult.response.search_results)) {
                const resultsList: any[] = taskRunResult.response.search_results;
    
                for (const result of resultsList) {
                    if (result.url && result.title && (String(result.url).startsWith("http://") || String(result.url).startsWith("https://"))) {
                        allResults.push({
                            processorName: processorName,
                            searchQuery: query,
                            title: String(result.title),
                            url: String(result.url),
                            snippet: String(result.snippet || ''),
                            documentType: 'duckduckgo_rb_search_result'
                        });
                    }
                }
                if (this.settings.verboseDebug) {
                    console.log(`Successfully processed ${resultsList.length} search results for query "${query}"`);
                }
            } else {
                new Notice(`DDG search via RB for "${query.substring(0, 20)}..." yielded no valid results.`, 3000);
                if (this.settings.verboseDebug) {
                    console.warn(`RB Task for DDG Search for query "${query}" did not return expected '{ "search_results": [...] }' array or failed. Full taskRunResult:`, taskRunResult);
                }
            }
            await new Promise(resolve => setTimeout(resolve, 700 + Math.random() * 500));
        }
        if (this.settings.verboseDebug) console.log(`searchViaRightBrainDuckDuckGo collected ${allResults.length} filtered candidates for ${processorName}`);
        return allResults;
    }


    async fetchProcessorSearchDataWithDiscovery(processorName: string): Promise<SearchData | null> {
        const collectedRelationships: ExtractedRelationship[] = [];
        const seenRelationshipsInCurrentSearch = new Set<string>(); // Tracks (Primary, Sub, Type)
        const processedUrlDetails: ProcessedUrlInfo[] = []; // Log of all URLs processed
        let candidateUrlsInfo: SerpApiResult[] = [];
        let flaggedCandidateUrlCount = 0;

        const rbToken = await this.getRightBrainAccessToken();
        if (!rbToken) {
            new Notice("Could not get RightBrain Access Token. Aborting discovery.", 7000);
            return null;
        }

        // Step 1: Initial Search (SerpAPI or RightBrain/DDG)
        if (this.settings.serpApiKey) {
            new Notice(`Using SerpAPI for primary search for: ${processorName}`, 5000);
            const searchQueries = this.generateSearchQueries(processorName);
            const serpApiResults = await this.searchSerpApiForDpas(processorName, searchQueries, this.settings.maxResultsPerProcessor);
            candidateUrlsInfo.push(...serpApiResults);
        } else if (this.settings.rightbrainOrgId && this.settings.rightbrainProjectId) { // Check if RightBrain is configured for DDG
            new Notice(`SerpAPI key not configured. Using DuckDuckGo (Filtered Extractor Task) via RightBrain for: ${processorName}`, 5000);
            // This call now uses the RB Task that filters and parses DDG results
            candidateUrlsInfo = await this.searchViaRightBrainDuckDuckGo(processorName, rbToken);
        } else {
            new Notice("No search method configured (SerpAPI or RightBrain for DDG). Aborting discovery.", 7000);
            // No need to return null immediately, as hardcoded URLs might still be processed if verboseDebug is on.
        }


        // Hardcoded URLs for testing (if enabled)
        const hardcodedTestUrls: Record<string, SerpApiResult[]> = {
            // "openai": [{ title: "Test OpenAI SubP List", url: "https://example.com/openai-subp", snippet: "", processorName: "openai", documentType: "hardcoded_test" }],
        }; // Keep this empty or manage it carefully
        if (this.settings.verboseDebug && hardcodedTestUrls[processorName.toLowerCase()]) {
            if (this.settings.verboseDebug) console.log(`Adding hardcoded test URLs for ${processorName}`);
            candidateUrlsInfo.push(...hardcodedTestUrls[processorName.toLowerCase()]);
        }
        
        // Step 2: (Optional) Extract more URLs from already identified DPA/Subprocessor list pages
        const additionalUrlsFromCandidatePages: SerpApiResult[] = [];
        const pagesToScanForMoreLinks = candidateUrlsInfo.filter(
            item => item.documentType === 'dpa_or_subprocessor_list' || SUBPROCESSOR_URL_KEYWORDS.some(kw => item.url.toLowerCase().includes(kw))
        );

        for (const pageItem of pagesToScanForMoreLinks) {
            const extracted = await this.extractUrlsFromDpaPage(pageItem.url, processorName, pageItem.title);
            additionalUrlsFromCandidatePages.push(...extracted);
        }
        candidateUrlsInfo.push(...additionalUrlsFromCandidatePages);


        // Create a unique list of URLs to process, prioritizing earlier found ones.
        const uniqueCandidateUrls = new Map<string, SerpApiResult>();
        candidateUrlsInfo.forEach(item => {
            if (item.url && (item.url.startsWith("http://") || item.url.startsWith("https://")) && !uniqueCandidateUrls.has(item.url.replace(/\/$/, ''))) { // Normalize URL by removing trailing slash
                uniqueCandidateUrls.set(item.url.replace(/\/$/, ''), item);
            }
        });
        const uniqueUrlsToProcess = Array.from(uniqueCandidateUrls.values());

        if (this.settings.verboseDebug) console.log(`Total unique URLs to verify for ${processorName}: ${uniqueUrlsToProcess.length}`);

        if (uniqueUrlsToProcess.length === 0 && candidateUrlsInfo.length > 0) {
             if (this.settings.verboseDebug) console.warn(`All candidate URLs were invalid or duplicates for ${processorName}. Original count: ${candidateUrlsInfo.length}`);
        } else if (uniqueUrlsToProcess.length === 0) { 
            new Notice(`No candidate URLs found to process for ${processorName}.`);
            // No URLs to process, so return current state (likely empty relationships)
            // return { collectedRelationships, processedUrlDetails, flaggedCandidateUrlCount };
        }


        // Step 3: Verify each unique URL and extract entities if it's a valid, current list
        for (const urlInfo of uniqueUrlsToProcess) {

            // Avoid re-processing if this exact URL was somehow added to processedUrlDetails already
            if (processedUrlDetails.some(p => p.url.replace(/\/$/, '') === urlInfo.url.replace(/\/$/, ''))) {
                 if(this.settings.verboseDebug) console.log(`URL ${urlInfo.url} already processed in processedUrlDetails, skipping re-verification.`);
                continue;
            }

            let currentUrlExtractedCount = 0;
            let currentProcessedUrlInfo: ProcessedUrlInfo = { ...urlInfo, documentType: urlInfo.documentType || 'duckduckgo_rb_search_result' }; 

            const verificationResult = await this.verifySubprocessorListUrl(urlInfo.url, processorName, rbToken);
            currentProcessedUrlInfo = { 
                ...currentProcessedUrlInfo,
                verificationMethod: 'rightbrain',
                isList: verificationResult?.isList || false,
                isCurrent: verificationResult?.isCurrent || false, 
                verificationReasoning: verificationResult?.reasoning || 'N/A'
            };

            // ---- THIS IS THE KEY LOGIC CHANGE ----
            if (verificationResult?.isList && verificationResult.isCurrent && verificationResult.isCorrectProcessor) {
                
                currentProcessedUrlInfo.documentType = 'verified_current_subprocessor_list';
                if (verificationResult.pageContent) {
                    const extractionResult = await this.extractEntitiesFromPageContent(verificationResult.pageContent, rbToken);
                    if (extractionResult) {
                        const { thirdPartySubprocessors, ownEntities } = extractionResult;
                        thirdPartySubprocessors.forEach(e => {
                            currentUrlExtractedCount += this.addRelationship(collectedRelationships, seenRelationshipsInCurrentSearch, processorName, e, "uses_subprocessor", urlInfo.url, verificationResult.reasoning);
                        });
                        ownEntities.forEach(e => {
                            currentUrlExtractedCount += this.addRelationship(collectedRelationships, seenRelationshipsInCurrentSearch, processorName, e, "is_own_entity", urlInfo.url, verificationResult.reasoning);
                        });
                    } else { currentProcessedUrlInfo.documentType = 'verified_current_subprocessor_list (rb_extraction_failed)'; }
                } else { currentProcessedUrlInfo.documentType = 'verified_current_subprocessor_list (no_content_for_extraction)';}
                
                currentProcessedUrlInfo.extractedSubprocessorsCount = currentUrlExtractedCount;
                processedUrlDetails.push(currentProcessedUrlInfo);

                // If we successfully extracted entities from a verified list, we are done.
                if (currentUrlExtractedCount > 0) {
                    if (this.settings.verboseDebug) console.log(`Found and processed a valid subprocessor list at ${urlInfo.url}. Stopping search.`);
                    new Notice(`Found valid list for ${processorName}. Finishing process.`);
                    break; // <-- EXIT THE LOOP EARLY
                }
                
            } else { // This block catches lists that are not current OR not for the correct processor
                const urlLower = urlInfo.url.toLowerCase();
                const containsKeyword = SUBPROCESSOR_URL_KEYWORDS.some(keyword => urlLower.includes(keyword));

                if (!verificationResult?.isList && containsKeyword) { 
                    currentProcessedUrlInfo.documentType = 'keyword_match_not_verified_list';
                    flaggedCandidateUrlCount++;
                } else if (verificationResult?.isList && !verificationResult.isCorrectProcessor) {
                    currentProcessedUrlInfo.documentType = 'verified_list_for_wrong_processor';
                    flaggedCandidateUrlCount++;
                } else if (verificationResult?.isList) { 
                    currentProcessedUrlInfo.documentType = 'verified_subprocessor_list (not_current)';
                } else { 
                    currentProcessedUrlInfo.documentType = 'not_a_subprocessor_list';
                }
                currentProcessedUrlInfo.extractedSubprocessorsCount = 0;
                processedUrlDetails.push(currentProcessedUrlInfo);
            }
        } // End of loop through unique URLs

        return { collectedRelationships, processedUrlDetails, flaggedCandidateUrlCount };
    }


    async fetchDataFromDirectUrl(processorName: string, listUrl: string): Promise<SearchData | null> {
        if (this.settings.verboseDebug) console.log(`Fetching data from direct URL for ${processorName}: ${listUrl}`);
        if (!this.isValidUrl(listUrl, processorName)) { // Basic URL validation
            new Notice(`The provided URL for ${processorName} is not valid: ${listUrl}`);
            return null;
        }

        const collectedRelationships: ExtractedRelationship[] = [];
        const seenRelationshipsInCurrentSearch = new Set<string>();
        const processedUrlDetails: ProcessedUrlInfo[] = [];
        let flaggedCandidateUrlCount = 0;

        const directUrlInfoBase: Partial<SerpApiResult> = { // Base info for this manually provided URL
            title: `Manually Provided List for ${processorName}`, url: listUrl,
            snippet: 'Manually provided URL', processorName: processorName, documentType: 'direct_input_list',
        };
        const currentProcessedUrlInfo: ProcessedUrlInfo = { ...directUrlInfoBase, url: listUrl, documentType: 'direct_input_list' };


        const rbToken = await this.getRightBrainAccessToken();
        if (!rbToken) { // RB token is essential for verification and extraction
            new Notice("Could not obtain RightBrain token for direct URL processing.");
            currentProcessedUrlInfo.verificationMethod = 'N/A (No RB Token)';
            processedUrlDetails.push(currentProcessedUrlInfo); // Log the attempt
            return { collectedRelationships, processedUrlDetails, flaggedCandidateUrlCount }; // Return with no data but with log
        }

        let currentUrlExtractedCount = 0;
        const verificationResult = await this.verifySubprocessorListUrl(listUrl, processorName,rbToken);

        // Update currentProcessedUrlInfo with verification details
        currentProcessedUrlInfo.verificationMethod = 'rightbrain';
        currentProcessedUrlInfo.isList = verificationResult?.isList || false;
        currentProcessedUrlInfo.isCurrent = verificationResult?.isCurrent || false; // isCurrent implies isList
        currentProcessedUrlInfo.verificationReasoning = verificationResult?.reasoning || 'N/A';

        if (verificationResult && verificationResult.isList && verificationResult.isCurrent) {
            new Notice(`Verified manual URL: ${listUrl} as current list.`);
            currentProcessedUrlInfo.documentType = 'verified_current_subprocessor_list (manual_url_input)';
            if (verificationResult.pageContent) {
                const extractionResult = await this.extractEntitiesFromPageContent(verificationResult.pageContent, rbToken);
                if (extractionResult) {
                    const { thirdPartySubprocessors, ownEntities } = extractionResult;
                    thirdPartySubprocessors.forEach(e => {
                        currentUrlExtractedCount += this.addRelationship(collectedRelationships, seenRelationshipsInCurrentSearch, processorName, e, "uses_subprocessor", listUrl, verificationResult.reasoning);
                    });
                    ownEntities.forEach(e => {
                        currentUrlExtractedCount += this.addRelationship(collectedRelationships, seenRelationshipsInCurrentSearch, processorName, e, "is_own_entity", listUrl, verificationResult.reasoning);
                    });
                } else { currentProcessedUrlInfo.documentType = 'verified_current_subprocessor_list (manual_url_input_rb_extraction_failed)';}
            } else {currentProcessedUrlInfo.documentType = 'verified_current_subprocessor_list (manual_url_input_no_content)';}
        } else { // Not verified as current and valid, or verification failed
            const urlLower = listUrl.toLowerCase();
            const containsKeyword = SUBPROCESSOR_URL_KEYWORDS.some(keyword => urlLower.includes(keyword));
            if (!verificationResult?.isList && containsKeyword) { // Looks like one (keyword), but RB says no
                currentProcessedUrlInfo.documentType = 'keyword_match_not_verified_list (manual_url_input)';
                flaggedCandidateUrlCount++;
                new Notice(`Manual URL ${listUrl} looks like a subprocessor list but couldn't be verified. Reason: ${this.scrubHyperlinks(verificationResult?.reasoning) || 'Details unavailable.'}`);
                if (this.settings.verboseDebug) console.log(`Flagged Manual URL (keyword match, not verified): ${listUrl}`);
            } else if (verificationResult?.isList) { // RB says it's a list, but not current
                currentProcessedUrlInfo.documentType = 'verified_subprocessor_list (manual_url_input_not_current)';
                new Notice(`Manual URL ${listUrl} verified as a list, but not current. Reason: ${this.scrubHyperlinks(verificationResult?.reasoning) || 'Details unavailable.'}`);
            } else { // RB says not a list, or verification failed more broadly
                currentProcessedUrlInfo.documentType = 'not_a_subprocessor_list (manual_url_input)';
                new Notice(`Manual URL ${listUrl} could not be verified as a list. Reason: ${this.scrubHyperlinks(verificationResult?.reasoning) || 'Details unavailable.'}`);
            }
        }
        currentProcessedUrlInfo.extractedSubprocessorsCount = currentUrlExtractedCount;
        processedUrlDetails.push(currentProcessedUrlInfo); // Log the processing attempt for this URL
        return { collectedRelationships, processedUrlDetails, flaggedCandidateUrlCount };
    }


    async fetchDataFromPastedText(processorName: string, pastedText: string): Promise<SearchData | null> {
        if (this.settings.verboseDebug) console.log(`Fetching data from pasted text for ${processorName}`);
        if (!this.settings.rightbrainExtractEntitiesTaskId) { // Check for the specific task ID
            new Notice("RightBrain Task ID for entity extraction is not configured. Please set it in plugin settings.");
            return null;
        }

        const collectedRelationships: ExtractedRelationship[] = [];
        const seenRelationshipsInCurrentSearch = new Set<string>();
        const processedUrlDetails: ProcessedUrlInfo[] = []; // To log this "text processing" event

        const rbToken = await this.getRightBrainAccessToken();
        if (!rbToken) { // RB token is essential
            new Notice("Could not obtain RightBrain token for pasted text processing.");
            // Log this attempt as a failure due to no token
            processedUrlDetails.push({
                url: `text_input_for_${this.sanitizeNameForFilePathAndAlias(processorName).filePathName}`, // Placeholder URL for logging
                title: `Pasted Text for ${processorName}`,
                documentType: 'manual_text_submission_failed (no_rb_token)',
                // No verification details applicable here as the process couldn't start
            });
            return { collectedRelationships, processedUrlDetails, flaggedCandidateUrlCount: 0 };
        }

        // Prepare input for the RB task based on configured field name
        const taskInput = { [this.settings.rightbrainExtractInputField]: pastedText };
        const extractionResult = await this.callRightBrainTask(this.settings.rightbrainExtractEntitiesTaskId, taskInput, rbToken);

        let currentUrlExtractedCount = 0;
        const sourcePlaceholder = `manual_text_input:${processorName}`; // For the SourceURL field

        if (extractionResult && typeof extractionResult.response === 'object' && extractionResult.response !== null) {
            const rbResponse = extractionResult.response;
            // Access extracted entities using configured field names
            const thirdParty = rbResponse[this.settings.rightbrainExtractOutputThirdPartyField] || [];
            const own = rbResponse[this.settings.rightbrainExtractOutputOwnEntitiesField] || [];

            thirdParty.forEach((e: any) => { // Assuming 'e' is an object with 'name', 'processing_function', 'location'
                currentUrlExtractedCount += this.addRelationship(collectedRelationships, seenRelationshipsInCurrentSearch, processorName, e, "uses_subprocessor", sourcePlaceholder, "Processed from manually pasted text.");
            });
            own.forEach((e: any) => {
                currentUrlExtractedCount += this.addRelationship(collectedRelationships, seenRelationshipsInCurrentSearch, processorName, e, "is_own_entity", sourcePlaceholder, "Processed from manually pasted text.");
            });

            // Log successful processing
            processedUrlDetails.push({ 
                url: sourcePlaceholder,
                title: `Pasted Text for ${processorName}`,
                documentType: 'manual_text_submission_processed',
                verificationMethod: 'rightbrain_text_task',
                extractedSubprocessorsCount: currentUrlExtractedCount,
                verificationReasoning: `Extracted ${currentUrlExtractedCount} entities from pasted text.`
            }); 
            
        } else { // RB task failed or returned unexpected format
            new Notice(`Failed to extract entities from pasted text for ${processorName}. Check console.`);
            console.error(`ProcessorProcessor: RB Extract From Text task did not return expected 'response' object or failed. Full task result:`, JSON.stringify(extractionResult).substring(0,500));
            // Log failed processing
            processedUrlDetails.push({ 
                url: sourcePlaceholder,
                title: `Pasted Text for ${processorName}`,
                documentType: 'manual_text_submission_failed (rb_task_error)',
                verificationMethod: 'rightbrain_text_task',
                verificationReasoning: 'RightBrain task for text processing failed or returned an unexpected response.'
            }); 
        }

        return { collectedRelationships, processedUrlDetails, flaggedCandidateUrlCount: 0 }; // flaggedCandidateUrlCount is 0 for text input
    }


    private async ensureFolderExists(folderPath: string): Promise<void> {
        // Normalize path: remove leading slash if present, as vault paths are relative to vault root
        try {
            const normalizedPath = folderPath.startsWith('/') ? folderPath.substring(1) : folderPath;
            if (normalizedPath === '') return; // Do nothing if path is empty (e.g. root, though not typical for this use)

            const abstractFolderPath = this.app.vault.getAbstractFileByPath(normalizedPath);
            if (!abstractFolderPath) {
                await this.app.vault.createFolder(normalizedPath);
                if (this.settings.verboseDebug) console.log(`Folder created: ${normalizedPath}`);
            }
            // else { if (this.settings.verboseDebug) console.log(`Folder already exists: ${normalizedPath}`); }
        } catch (e) {
            // Don't throw, but log and notify. The operation might still proceed if the folder exists but an error occurred checking.
            console.error(`Error ensuring folder ${folderPath} exists:`, e);
            new Notice(`Error creating folder: ${folderPath}`);
        }
    }

    private async ensureProcessorFile(originalProcessorName: string, addFrontmatter = false, isTopLevelProcessor = true): Promise<TFile | null> {
        await this.ensureFolderExists(this.settings.processorsFolderPath);
        const { filePathName, originalNameAsAlias } = this.sanitizeNameForFilePathAndAlias(originalProcessorName);
        const folder = this.settings.processorsFolderPath.startsWith('/') ? this.settings.processorsFolderPath.substring(1) : this.settings.processorsFolderPath;
        const filePath = `${folder}/${filePathName}.md`;
        let file = this.app.vault.getAbstractFileByPath(filePath) as TFile;
    
        if (!file) {
            try {
                let initialContent = "";
                if (addFrontmatter) {
                    const tag = isTopLevelProcessor ? 'processor' : 'subprocessor';
                    const aliasForFrontmatter = originalNameAsAlias.replace(/[:[\]",]/g, ''); 
                    initialContent = `---\ntags: [${tag}]\naliases: ["${aliasForFrontmatter}"]\n---\n\n# ${originalNameAsAlias}\n\n`;
                } else {
                    initialContent = `# ${originalNameAsAlias}\n\n`; 
                }
                file = await this.app.vault.create(filePath, initialContent);
            } catch (e: any) {
                 if (e.message?.toLowerCase().includes("file already exists")) {
                    // Add a small delay and retry to handle race condition
                    await new Promise(resolve => setTimeout(resolve, 100));
                    file = this.app.vault.getAbstractFileByPath(filePath) as TFile;
                    if (!file) {
                        // Try one more time after a longer delay
                        await new Promise(resolve => setTimeout(resolve, 500));
                        file = this.app.vault.getAbstractFileByPath(filePath) as TFile;
                        if (!file) {
                            if (this.settings.verboseDebug) console.warn(`Could not retrieve processor file ${filePath} after 'already exists' error. This is likely a temporary issue.`);
                            return null; // Gracefully return null for now
                        }
                    }
                 } else { console.error(`Error creating processor file ${filePath}:`, e); return null; }
            }
        }
        if (file && addFrontmatter) {
            const tag = isTopLevelProcessor ? 'processor' : 'subprocessor';
            const aliasForFrontmatter = originalNameAsAlias.replace(/[:[\]",]/g, '');
            await this.app.vault.process(file, (content) => {
                let newContent = this.updateFrontmatter(content, { tags: [tag], aliases: [aliasForFrontmatter] }, originalNameAsAlias);
                if (!newContent.trim().includes(`# ${originalNameAsAlias}`)) {
                    const bodyStartIndex = newContent.indexOf('\n---') > 0 ? newContent.indexOf('\n---', newContent.indexOf('\n---') + 3) + 4 : 0;
                    const body = newContent.substring(bodyStartIndex);
                    const frontmatterPart = newContent.substring(0, bodyStartIndex);
                    newContent = frontmatterPart + (frontmatterPart.endsWith("\n") ? "" : "\n") + `# ${originalNameAsAlias}\n\n` + body.trimStart();
                }
                return newContent;
            });
        }
        return file;
    }


    private async updateProcessorFile(file: TFile, originalProcessorName: string, relationships: ExtractedRelationship[], isTopLevelProcessor: boolean) {
        const subprocessorsHeading = "Subprocessors";
        let tableMd = `| Subprocessor Entity Name | Processing Function | Location |\n`;
        tableMd += `|---|---|---|\n`;

        // Filter for 'uses_subprocessor' relationships where the current processor is the PrimaryProcessor
        const relevantRelationships = relationships.filter(r => r.RelationshipType === 'uses_subprocessor' && r.PrimaryProcessor === originalProcessorName);

        relevantRelationships.forEach(rel => {
            // Sanitize the subprocessor's name for file path and get original for alias
            const { filePathName: subFilePathName, originalNameAsAlias: subOriginalName } = this.sanitizeNameForFilePathAndAlias(rel.SubprocessorName);
            // Prepare display alias for Markdown link (remove chars that break links/display)
            const markdownAlias = subOriginalName.replace(/\n/g, ' ').replace(/[\[\]()|]/g, ''); // Basic sanitization for link text

            const processorsFolder = this.settings.processorsFolderPath; // No leading/trailing slashes needed by encodeURI if path is clean
            const markdownLinkTarget = encodeURI(`${processorsFolder}/${subFilePathName}.md`); // Use sanitized name for link target

            const subprocessorPageLink = `[${markdownAlias}](${markdownLinkTarget})`; // Use standard Markdown link format

            // Scrub and prepare display for processing function and location
            const processingFunctionDisplay = (rel.ProcessingFunction || "N/A").replace(/\n/g, "<br>").replace(/\|/g, "\\|");
            const locationDisplay = (rel.Location || "N/A").replace(/\n/g, "<br>").replace(/\|/g, "\\|");

            tableMd += `| ${subprocessorPageLink} | ${processingFunctionDisplay} | ${locationDisplay} |\n`;
        });


        const analysisLogsHeading = "Analysis Logs";
        // Sanitize processor name for log file name part
        const { filePathName: logFilePathNamePart } = this.sanitizeNameForFilePathAndAlias(originalProcessorName);
        const analysisLogsFolder = this.settings.analysisLogsFolderPath; // Normalized
        const logFileName = `${logFilePathNamePart} Subprocessor Logs.md`;
                    // const logFileLinkTarget = encodeURI(`${analysisLogsFolder}/${logFileName}`); // Use sanitized name for log file link
        const logFileLink = `[[${analysisLogsFolder}/${logFileName}|${originalProcessorName} Subprocessor Logs]]`; // Obsidian link to log
        const analysisLogSection = `\n- ${logFileLink}\n`;

        await this.app.vault.process(file, (content: string) => {
            const tag = isTopLevelProcessor ? 'processor' : 'subprocessor';
            let newContent = this.updateFrontmatter(content, { tags: [tag], aliases: [originalProcessorName.replace(/[:\[\],"]/g, '')] }, originalProcessorName);

            // Ensure H1 heading for originalProcessorName
            if (!newContent.trim().includes(`# ${originalProcessorName}`)) {
                 const bodyStartIndex = newContent.indexOf('\n---') > 0 ? newContent.indexOf('\n---', newContent.indexOf('\n---') + 3) + 4 : 0;
                 const body = newContent.substring(bodyStartIndex);
                 const frontmatterPart = newContent.substring(0, bodyStartIndex);
                 newContent = frontmatterPart + (frontmatterPart.endsWith("\n") ? "" : "\n") + `# ${originalProcessorName}\n\n` + body.trimStart();
            }

            // Ensure/Update Subprocessors section
            newContent = this.ensureHeadingAndSection(newContent, subprocessorsHeading, tableMd, null, null); // Replace entire section
            // Ensure/Update Analysis Logs section
            newContent = this.ensureHeadingAndSection(newContent, analysisLogsHeading, analysisLogSection, null, null, true); // Append if heading exists, else create
            return newContent;
        });
    }


    private async createOrUpdateSubprocessorFile(
        originalSubprocessorName: string, // The name of the subprocessor itself (e.g., "AWS")
        originalPrimaryProcessorNameForContext: string, // The primary processor currently being processed (e.g., "OpenAI") - for context, not usually main content of AWS.md
        newClientRelationships: ExtractedRelationship[] // Relationships where originalSubprocessorName is the target (SubprocessorName) and type is 'uses_subprocessor'
    ) {
        await this.ensureFolderExists(this.settings.processorsFolderPath);
        const { filePathName: subFilePathName, originalNameAsAlias: subOriginalNameAsAlias } = this.sanitizeNameForFilePathAndAlias(originalSubprocessorName);
        const folder = this.settings.processorsFolderPath.startsWith('/') ? this.settings.processorsFolderPath.substring(1) : this.settings.processorsFolderPath;
        const subFilePath = `${folder}/${subFilePathName}.md`;

        let file = this.app.vault.getAbstractFileByPath(subFilePath) as TFile;
        if (!file) {
            const aliasForFrontmatter = subOriginalNameAsAlias.replace(/[:\[\],"]/g, '');
            const initialContent = `---\ntags: [subprocessor]\naliases: ["${aliasForFrontmatter}"]\n---\n\n# ${subOriginalNameAsAlias}\n\n## Used By\n\n`;
            try {
                file = await this.app.vault.create(subFilePath, initialContent);
            } catch (e: any) {
                if (e.message?.toLowerCase().includes("file already exists")) {
                    // Add a small delay and retry to handle race condition
                    await new Promise(resolve => setTimeout(resolve, 100));
                    file = this.app.vault.getAbstractFileByPath(subFilePath) as TFile;
                    if (!file) {
                        // Try one more time after a longer delay
                        await new Promise(resolve => setTimeout(resolve, 500));
                        file = this.app.vault.getAbstractFileByPath(subFilePath) as TFile;
                        if (!file) {
                            if (this.settings.verboseDebug) console.warn(`Could not retrieve subprocessor file ${subFilePath} after 'already exists' error. This is likely a temporary issue.`);
                            return; // Gracefully skip this file for now
                        }
                    }
                } else { 
                    console.error(`Error creating subprocessor file ${subFilePath}:`, e); 
                    return; 
                }
            }
        }

        if (!file) return; // Should not happen if creation/retrieval was successful

        await this.app.vault.process(file, (content: string) => {
            let newContent = this.updateFrontmatter(content, { tags: ["subprocessor"], aliases: [subOriginalNameAsAlias.replace(/[:\[\],"]/g, '')] }, subOriginalNameAsAlias);
            if (!newContent.trim().includes(`# ${subOriginalNameAsAlias}`)) {
                 const bodyStartIndex = newContent.indexOf('\n---') > 0 ? newContent.indexOf('\n---', newContent.indexOf('\n---') + 3) + 4 : 0;
                 const body = newContent.substring(bodyStartIndex);
                 const frontmatterPart = newContent.substring(0, bodyStartIndex);
                 newContent = frontmatterPart + (frontmatterPart.endsWith("\n") ? "" : "\n") + `# ${subOriginalNameAsAlias}\n\n` + body.trimStart();
            }

            const usedByHeading = "Used By";
            
            // Step 1: Extract existing rows and put them in a Set to handle uniqueness
            const existingRows = this.extractClientTableRows(content);
            const allRows = new Set<string>(existingRows);

            // Step 2: Process new relationships and add them to the Set
            newClientRelationships.forEach(rel => {
                const { originalNameAsAlias: primaryOriginalName } = this.sanitizeNameForFilePathAndAlias(rel.PrimaryProcessor);
                // We no longer create a link, so we just use the name and escape any pipe characters.
                const primaryProcessorPlainText = primaryOriginalName.replace(/\|/g, "\\|");

                const processingFunctionDisplay = (rel.ProcessingFunction || "N/A").replace(/\n/g, "<br>").replace(/\|/g, "\\|");
                const locationDisplay = (rel.Location || "N/A").replace(/\n/g, "<br>").replace(/\|/g, "\\|");
                const sourceUrlLink = rel.SourceURL.startsWith("http") ? `[Source](${rel.SourceURL})` : rel.SourceURL;
            
                // Create the inner content of the row, now using plain text for the primary processor.
                const rowContent = ` ${primaryProcessorPlainText} | ${processingFunctionDisplay} | ${locationDisplay} | ${sourceUrlLink} `;
                allRows.add(rowContent);
            });
            
            // Step 3: Build the final, complete table from the Set of all rows
            let clientTableMd = `| Primary Processor | Processing Function | Location | Source URL |\n`;
            clientTableMd += `|---|---|---|---|\n`;
            allRows.forEach(row => {
                // Re-add the outer pipes for each row
                clientTableMd += `|${row}|\n`;
            });

            // Step 4: Replace the old section with the new, merged table
            newContent = this.ensureHeadingAndSection(newContent, usedByHeading, clientTableMd, null, null);
            return newContent;
        });
    }


    private updateFrontmatter(content: string, updates: { tags?: string[], aliases?: string[] }, pageNameForAlias: string): string {
        let fm: any = {};
        const fmRegex = /^---\s*\n([\s\S]*?)\n---\s*\n/;
        const match = content.match(fmRegex);
        let body = content;

        if (match && match[1]) {
            try {
                // Basic YAML parsing - for more complex YAML, a library would be needed
                const yamlLines = match[1].split('\n');
                yamlLines.forEach(line => {
                    const parts = line.split(':');
                    if (parts.length >= 2) {
                        const key = parts[0].trim();
                        const value = parts.slice(1).join(':').trim();
                        if (key === 'tags' || key === 'aliases') {
                            // Try to parse as array if it looks like one, otherwise treat as string
                            if (value.startsWith('[') && value.endsWith(']')) {
                                fm[key] = value.substring(1, value.length - 1).split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
                            } else { // Single item not in list format
                                fm[key] = [value.replace(/^["']|["']$/g, '')];
                            }
                        } else {
                            fm[key] = value.replace(/^["']|["']$/g, ''); // Simple string value
                        }
                    }
                });
            } catch (e) {
                console.warn("ProcessorProcessor: Could not parse existing frontmatter, will overwrite relevant keys.", e);
                fm = {}; // Reset if parsing fails
            }
            body = content.substring(match[0].length);
        }

        // Update tags
        if (updates.tags) {
            const currentTags = new Set(Array.isArray(fm.tags) ? fm.tags.map((t: string) => String(t).toLowerCase()) : []);
            updates.tags.forEach(tag => currentTags.add(String(tag).toLowerCase()));
            fm.tags = Array.from(currentTags);
        }

        // Update aliases, ensuring pageNameForAlias (sanitized) is present
        if (updates.aliases) {
            const currentAliases = new Set(Array.isArray(fm.aliases) ? fm.aliases.map((a: string) => String(a)) : []);
            updates.aliases.forEach(alias => {
                const sanitizedAlias = String(alias).replace(/[:\[\],"]/g, ''); // Sanitize for YAML
                if (sanitizedAlias) currentAliases.add(sanitizedAlias);
            });
            // Ensure the main pageNameForAlias (sanitized) is also present as an alias
            const sanitizedPageNameAlias = String(pageNameForAlias).replace(/[:\[\],"]/g, '');
            if (sanitizedPageNameAlias) currentAliases.add(sanitizedPageNameAlias);

            fm.aliases = Array.from(currentAliases);
        }


        // Reconstruct frontmatter string
        let fmString = "---\n";
        for (const key in fm) {
            if (fm.hasOwnProperty(key)) {
                if (Array.isArray(fm[key])) {
                    if (fm[key].length > 0) {
                        fmString += `${key}: [${fm[key].map((item: string) => `"${item}"`).join(', ')}]\n`;
                    }
                } else {
                    fmString += `${key}: "${fm[key]}"\n`;
                }
            }
        }
        fmString += "---\n";

        // If there was no original frontmatter and we didn't actually add any valid fm, don't prepend empty fm block
        if (fmString === "---\n---\n" && !match) {
            return body;
        }

        return fmString + body;
    }


    private async updateAnalysisLogPage(processorName: string, processedUrls: ProcessedUrlInfo[], relationships: ExtractedRelationship[], mergeDecisions: string[]) {
        await this.ensureFolderExists(this.settings.analysisLogsFolderPath);
        const { filePathName: sanitizedProcessorNameForLogFile } = this.sanitizeNameForFilePathAndAlias(processorName);

        const logsFolder = this.settings.analysisLogsFolderPath; // Normalized
        const logFileName = `${sanitizedProcessorNameForLogFile} Subprocessor Logs.md`; // Use sanitized name
        const logFilePath = `${logsFolder}/${logFileName}`;

        const logEntryContent = this.formatResultsForObsidianLog(processorName, relationships, processedUrls, mergeDecisions);

        // Use ensure_exists_and_append mode. The title is handled by formatResultsForObsidianLog.
        await this.writeResultsToObsidianNote(logFilePath, logEntryContent, 'ensure_exists_and_append', processorName);
    }


    private ensureHeadingAndSection(
        content: string,
        headingText: string,
        sectionNewContent: string,
        startMarker: string | null = null, // e.g., <!-- START: SUBPROCESSORS -->
        endMarker: string | null = null,   // e.g., <!-- END: SUBPROCESSORS -->
        appendUnderHeadingIfNoMarkers = false // If true and markers not found, appends under existing heading if found
    ): string {
        const headingRegex = new RegExp(`^(#+)\\s*${headingText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s*\\n|$)`, "im");
        const headingMatch = content.match(headingRegex);
        const sectionWithHeading = `\n## ${headingText}\n${sectionNewContent.trim()}\n`;

        if (startMarker && endMarker) {
            const startIdx = content.indexOf(startMarker);
            const endIdx = content.indexOf(endMarker);

            if (startIdx !== -1 && endIdx !== -1 && startIdx < endIdx) {
                // Markers found, replace content between them (exclusive of markers themselves)
                return content.substring(0, startIdx + startMarker.length) +
                       `\n${sectionNewContent.trim()}\n` + // Ensure new content is on new lines
                       content.substring(endIdx);
            }
        }

        // Markers not used or not found, try to find heading
        if (headingMatch) {
            // Heading found
            const headingLevel = headingMatch[1].length; // e.g., "##" -> length 2
            const nextHeadingRegex = new RegExp(`^#{1,${headingLevel}}\\s+.*(\\s*\\n|$)`, "im");
            const startIndexAfterHeading = headingMatch.index! + headingMatch[0].length;
            const contentAfterHeading = content.substring(startIndexAfterHeading);
            let endIndex = content.length; // Default to end of content

            // Find where the current section ends (start of next heading of same or higher level, or end of doc)
            const nextMatch = contentAfterHeading.match(nextHeadingRegex);
            if (nextMatch) {
                endIndex = startIndexAfterHeading + nextMatch.index!;
            }

            if (appendUnderHeadingIfNoMarkers) {
                 // Append new content under the existing heading, before the next one.
                 // This is tricky if the section already has content. This simple append adds to the end of the section.
                 // For full replacement, the logic outside this `if` handles it.
                 return content.substring(0, endIndex) + // Content up to where next section would start (or end of doc)
                        `\n${sectionNewContent.trim()}\n` + // Append new stuff
                        content.substring(endIndex);      // Rest of the document
            } else {
                 // Replace content from after the headingMatch to where the next heading/end of doc starts
                 return content.substring(0, startIndexAfterHeading) +
                        `${sectionNewContent.trim()}\n` +
                        content.substring(endIndex);
            }

        } else {
            // Heading not found, append the new heading and section to the end
            return content.trimEnd() + "\n\n" + sectionWithHeading.trimStart();
        }
    }


    private formatResultsForObsidianLog(processorName: string, relationships: ExtractedRelationship[], processedUrls: ProcessedUrlInfo[], mergeDecisions: string[] = []): string {
        let logContent = `\n---\n### Log Entry: ${new Date().toISOString()} for ${processorName}\n\n`;

        if (mergeDecisions.length > 0) {
            logContent += `#### Proactive Deduplication Decisions (${mergeDecisions.length}):\n`;
            mergeDecisions.forEach(decision => {
                logContent += `- ${decision}\n`;
            });
            logContent += "\n";
        }

        logContent += `#### Processed URLs (${processedUrls.length}):\n`;
        if (processedUrls.length === 0) {
            logContent += "- No URLs were processed.\n";
        } else {
            logContent += "| URL | Title | Type | Verified List? | Current? | Extracted # | Reasoning |\n";
            logContent += "|---|---|---|---|---|---|---|\n";
            processedUrls.forEach(url => {
                const titleDisplay = this.scrubHyperlinks(url.title || "N/A").substring(0, 70);
                const urlLink = url.url.startsWith("http") ? `[Link](${url.url})` : url.url;
                const reasoningDisplay = this.scrubHyperlinks(url.verificationReasoning || "N/A").substring(0, 100);
                logContent += `| ${urlLink} | ${titleDisplay}... | ${url.documentType || 'N/A'} | ${url.isList ? 'Yes' : 'No'} | ${url.isCurrent ? 'Yes' : 'No'} | ${url.extractedSubprocessorsCount || 0} | ${reasoningDisplay}... |\n`;
            });
        }
        logContent += "\n";

        logContent += `#### Extracted Relationships (${relationships.length}):\n`;
        if (relationships.length === 0) {
            logContent += "- No new relationships were extracted in this run.\n";
        } else {
            logContent += "| Primary Processor | Target Entity | Type | Function | Location | Source URL |\n";
            logContent += "|---|---|---|---|---|---|\n";
            relationships.forEach(rel => {
                const targetEntityDisplay = this.scrubHyperlinks(rel.SubprocessorName).substring(0, 50);
                const primaryProcDisplay = this.scrubHyperlinks(rel.PrimaryProcessor).substring(0, 50);
                const funcDisplay = this.scrubHyperlinks(rel.ProcessingFunction).substring(0, 70);
                const locDisplay = this.scrubHyperlinks(rel.Location).substring(0, 50);
                const sourceUrlLink = rel.SourceURL.startsWith("http") ? `[Source](${rel.SourceURL})` : rel.SourceURL;

                logContent += `| ${primaryProcDisplay} | ${targetEntityDisplay} | ${rel.RelationshipType} | ${funcDisplay}... | ${locDisplay}... | ${sourceUrlLink} |\n`;
            });
        }
        logContent += "\n";
        return logContent;
    }


    private async writeResultsToObsidianNote(
        filePath: string, // Full path from vault root, e.g., "Analysis Logs/OpenAI Logs.md"
        contentToAppendOrInitial: string,
        mode: 'overwrite' | 'append' | 'ensure_exists_and_append' = 'ensure_exists_and_append',
        processorNameForLogTitle?: string // Used if creating the file
    ) {
        let file = this.app.vault.getAbstractFileByPath(filePath) as TFile;

        if (!file && (mode === 'ensure_exists_and_append' || mode === 'overwrite')) {
            // File doesn't exist, create it
            let initialContent = "";
            if (processorNameForLogTitle) {
                initialContent += `# Analysis Log: ${processorNameForLogTitle}\n\n`;
            }
            initialContent += contentToAppendOrInitial; // Add the current log entry
            try {
                file = await this.app.vault.create(filePath, initialContent);
                if (this.settings.verboseDebug) console.log(`Log file created: ${filePath}`);
            } catch (e: any) {
                 if (e.message?.toLowerCase().includes("file already exists")) {
                    file = this.app.vault.getAbstractFileByPath(filePath) as TFile;
                     if (!file) { console.error(`Failed to get log file ${filePath} after 'already exists' error.`); return; }
                      // Now that file exists, proceed to append/process if mode is ensure_exists_and_append
                 } else {
                    console.error(`Error creating log file ${filePath}:`, e);
                    new Notice(`Error creating log file: ${filePath}`);
                    return; // Stop if creation fails
                }
            }
             if (file && mode === 'ensure_exists_and_append') { /* File created with content, no further action for this call */ return; }
        }


        // If file exists (or was just created and mode is not 'ensure_exists_and_append' where content was initial)
        if (file) {
            if (mode === 'overwrite') {
                let newContent = "";
                if (processorNameForLogTitle) { // Keep the title if overwriting
                    newContent += `# Analysis Log: ${processorNameForLogTitle}\n\n`;
                }
                newContent += contentToAppendOrInitial;
                await this.app.vault.modify(file, newContent);
                if (this.settings.verboseDebug) console.log(`Log file overwritten: ${filePath}`);
            } else if (mode === 'append' || (mode === 'ensure_exists_and_append' && file)) { // Append if mode is append or (ensure_exists_and_append and file already existed)
                await this.app.vault.append(file, contentToAppendOrInitial);
                if (this.settings.verboseDebug) console.log(`Content appended to log file: ${filePath}`);
            }
        } else if (mode === 'append') {
            // File doesn't exist and mode is 'append' (strict append, not create)
            new Notice(`Log file ${filePath} not found. Cannot append.`);
            if (this.settings.verboseDebug) console.log(`Log file not found for append: ${filePath}`);
        }
    }


    async getRightBrainAccessToken(creds?: { clientId: string, clientSecret: string, oauthUrl: string }): Promise<string | null> {
        // Use the passed-in credentials if they exist, otherwise use the saved settings.
        const clientId = creds?.clientId || this.settings.rightbrainClientId;
        const clientSecret = creds?.clientSecret || this.settings.rightbrainClientSecret;
        const oauthUrl = creds?.oauthUrl || this.settings.rightbrainOauth2Url;

        if (!clientId || !clientSecret) {
            new Notice("RightBrain Client ID or Secret not configured.");
            return null;
        }

        // Check for the cached token first
        if ((this as any)._rbToken && (this as any)._rbTokenExpiry > Date.now()) {
            if (this.settings.verboseDebug) console.log("Using cached RightBrain token.");
            return (this as any)._rbToken;
        }

        const tokenUrl = `${oauthUrl}/oauth2/token`;
        
        const bodyParams = new URLSearchParams();
        bodyParams.append('grant_type', 'client_credentials');

        const credentials = `${clientId}:${clientSecret}`;
        const encodedCredentials = btoa(credentials); 

        const headers = {
            'Authorization': `Basic ${encodedCredentials}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': `ObsidianProcessorProcessorPlugin/${this.manifest.version}`
        };

        try {
            if (this.settings.verboseDebug) console.log("Requesting new RightBrain token.");
            const response = await requestUrl({
                url: tokenUrl,
                method: 'POST',
                headers: headers,
                body: bodyParams.toString(),
                throw: false
            });

            if (response.status === 200 && response.json && response.json.access_token) {
                if (this.settings.verboseDebug) console.log("Successfully obtained new RightBrain token.");
                (this as any)._rbToken = response.json.access_token;
                (this as any)._rbTokenExpiry = Date.now() + (response.json.expires_in || 3600) * 1000 - 600000;
                return response.json.access_token;
            } else {
                console.error("ProcessorProcessor: Failed to get RightBrain token.", response.status, response.text);
                new Notice(`Failed to get RightBrain token: ${response.status}.`);
                (this as any)._rbToken = null;
                (this as any)._rbTokenExpiry = 0;
                return null;
            }
        } catch (error) {
            console.error("ProcessorProcessor: Network error fetching RightBrain token:", error);
            new Notice("Network error fetching RightBrain token.");
            (this as any)._rbToken = null;
            (this as any)._rbTokenExpiry = 0;
            return null;
        }
    }


    private generateSearchQueries(processorName: string): string[] {
        // Sanitize processorName for use in queries (e.g., remove "Inc.", "LLC")
        const cleanedName = processorName
            .replace(/\b(?:inc\.?|llc\.?|ltd\.?|corp\.?|gmbh\.?|incorporated|limited|corporation)\b/gi, '')
            .replace(/[,.]/g, '') // Remove commas and periods that might break search
            .trim();

        return [
            `"${cleanedName}" sub-processor list`,
            `"${cleanedName}" subprocessors`,
            `"${cleanedName}" data processing addendum exhibit`,
            `"${cleanedName}" DPA subprocessors`,
            `"${cleanedName}" third-party vendors`,
            `"${cleanedName}" service providers list`,
            // More generic but sometimes useful for finding portals
            `"${cleanedName}" trust center subprocessors`,
            `"${cleanedName}" legal subprocessors`,
            // If the name is short, broad searches might be too noisy.
            // Consider adding quotes around cleanedName if it contains spaces.
        ];
    }


    private async searchSerpApiForDpas(processorName: string, queries: string[], maxResultsSetting: number): Promise<SerpApiResult[]> {
        if (!this.settings.serpApiKey) {
            new Notice("SerpAPI key not set. Cannot perform SerpAPI search.");
            return [];
        }

        const allResults: SerpApiResult[] = [];
        const processedUrls = new Set<string>(); // To avoid duplicate URLs from different queries

        // Use a smaller number of queries for SerpAPI to manage cost/rate limits
        const queriesToRun = queries.slice(0, Math.min(queries.length, 3)); // e.g., run first 3 queries

        new Notice(`Searching SerpAPI for ${processorName} using ${queriesToRun.length} queries...`, 3000);

        for (const query of queriesToRun) {
            if (allResults.length >= maxResultsSetting && maxResultsSetting > 0) {
                // if (this.settings.verboseDebug) console.log(`Max results (${maxResultsSetting}) reached for ${processorName}, stopping SerpAPI search.`);
                break; // Stop if we've hit the overall max results desired (though logic is 1)
            }

            const params = new URLSearchParams({
                api_key: this.settings.serpApiKey,
                q: query,
                engine: "google", // Or other engines like 'bing'
                num: "10", // Number of results per query (max 100 for Google, usually 10-20 is fine)
                // You can add other params like 'location', 'gl' (country), 'hl' (language) if needed
            });
            const serpApiUrl = `https://serpapi.com/search?${params.toString()}`;

            try {
                const response = await requestUrl({ url: serpApiUrl, method: 'GET', throw: false });
                if (response.status === 200 && response.json && response.json.organic_results) {
                    const organicResults = response.json.organic_results;
                    for (const result of organicResults) {
                        if (result.link && !processedUrls.has(result.link)) {
                            const urlLower = result.link.toLowerCase();
                            const titleLower = result.title?.toLowerCase() || "";
                            const snippetLower = result.snippet?.toLowerCase() || "";

                            // Basic keyword check in URL, title, or snippet
                            const isRelevant = SUBPROCESSOR_URL_KEYWORDS.some(keyword =>
                                urlLower.includes(keyword) || titleLower.includes(keyword) || snippetLower.includes(keyword)
                            );

                            if (isRelevant) {
                                allResults.push({
                                    processorName: processorName,
                                    title: result.title || "No Title",
                                    url: result.link,
                                    snippet: result.snippet || "No Snippet",
                                    searchQuery: query,
                                    documentType: 'serpapi_dpa_or_subprocessor_list_candidate' // Mark as potential candidate
                                });
                                processedUrls.add(result.link);
                                if (allResults.length >= maxResultsSetting && maxResultsSetting > 0) break;
                            }
                        }
                    }
                } else {
                    console.error(`SerpAPI error for query "${query}": ${response.status}`, response.text?.substring(0, 200));
                    new Notice(`SerpAPI query failed for "${query.substring(0,20)}...". Status: ${response.status}`);
                }
            } catch (error) {
                console.error(`Network error during SerpAPI search for query "${query}":`, error);
                new Notice(`Network error during SerpAPI search for "${query.substring(0,20)}...".`);
            }
            await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 300)); // Delay between API calls
        }
        if (this.settings.verboseDebug) console.log(`SerpAPI search for ${processorName} found ${allResults.length} relevant candidates.`);
        return allResults;
    }


    private getCompanyDomain(processorName: string): string {
        // Basic domain extraction - this is naive and can be improved.
        // It assumes processorName might be like "Company Name Inc." or "company.com"
        let name = processorName.toLowerCase();
        name = name.replace(/\b(?:inc\.?|llc\.?|ltd\.?|corp\.?|gmbh\.?)\b/g, '').trim(); // Remove common suffixes
        name = name.replace(/[,.]/g, ''); // Remove commas, periods

        try {
            // If it looks like a URL already
            if (name.includes('.') && !name.includes(' ')) {
                const url = new URL(name.startsWith('http') ? name : `http://${name}`);
                return url.hostname.replace(/^www\./, ''); // Remove www.
            }
        } catch (e) { /* Not a valid URL, proceed */ }

        // If it's a multi-word name, try to form a domain (e.g., "Company Name" -> "companyname.com")
        // This is highly speculative and often wrong.
        // A better approach is to look for official website in search results.
        const parts = name.split(/\s+/);
        if (parts.length > 1) {
            // return parts.join('').toLowerCase() + ".com"; // Very naive
            return ""; // Better to not guess if unsure
        }
        return name; // If single word, assume it might be part of a domain
    }


    private isValidUrl(url: string, processorNameContext = ""): boolean {
        if (!url || typeof url !== 'string') return false;
        try {
            const parsedUrl = new URL(url);
            // Allow http and https protocols
            if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
                return false;
            }
            // Optional: check if domain seems related to processorNameContext if provided
            if (processorNameContext) {
                const processorDomain = this.getCompanyDomain(processorNameContext);
                if (processorDomain && !parsedUrl.hostname.toLowerCase().includes(processorDomain.replace(/^www\./, ''))) {
                    // This is a soft check, might be too restrictive.
                    // if (this.settings.verboseDebug) console.log(`URL ${url} hostname ${parsedUrl.hostname} doesn't match context ${processorDomain}`);
                }
            }
            return true;
        } catch (e) {
            return false; // Invalid URL format
        }
    }


    private async extractUrlsFromDpaPage(pageUrl: string, processorNameContext: string, sourcePageTitle?: string): Promise<SerpApiResult[]> {
        if (!this.settings.rightbrainVerifyUrlTaskId) { // Using verify task ID as a proxy for "RB is configured"
            // if (this.settings.verboseDebug) console.log("RB not configured, skipping URL extraction from DPA page content.");
            return [];
        }
        const rbToken = await this.getRightBrainAccessToken();
        if (!rbToken) return [];

        const extractedLinks: SerpApiResult[] = [];

        // This would ideally use a RightBrain task designed to fetch a page and extract all <a> hrefs.
        // For now, let's simulate a simplified version of what such a task might return if we pass pageUrl.
        // A proper RB task would take `pageUrl` as input to a `url_fetcher` and then parse its HTML output.

        // Simulate fetching page content (very basic, not robust)
        let pageContent = "";
        try {
            const response = await requestUrl({url: pageUrl, method: 'GET', throw: false});
            if (response.status === 200) {
                pageContent = response.text;
            } else {
                // if (this.settings.verboseDebug) console.warn(`Failed to fetch ${pageUrl} for link extraction, status: ${response.status}`);
                return [];
            }
        } catch (e) {
            // if (this.settings.verboseDebug) console.error(`Error fetching ${pageUrl} for link extraction:`, e);
            return [];
        }

        if (!pageContent) return [];

        // Simple regex to find href attributes in <a> tags
        const linkRegex = /<a\s+(?:[^>]*?\s+)?href="([^"]*)"/gi;
        let match;
        while ((match = linkRegex.exec(pageContent)) !== null) {
            const href = match[1].trim();
            if (href && !href.startsWith('#') && !href.startsWith('mailto:') && !href.startsWith('javascript:')) {
                try {
                    const absoluteUrl = new URL(href, pageUrl).toString(); // Resolve relative URLs
                    if (this.isValidUrl(absoluteUrl, processorNameContext)) {
                        // Check if this link itself looks like a subprocessor list
                        const urlLower = absoluteUrl.toLowerCase();
                         const titleOrTextLower = (match[0].match(/>(.*?)</)?.[1] || "").toLowerCase(); // Get link text

                        const isPotentialSubprocessorList = SUBPROCESSOR_URL_KEYWORDS.some(keyword =>
                            urlLower.includes(keyword) || titleOrTextLower.includes(keyword)
                        );

                        if (isPotentialSubprocessorList) {
                            extractedLinks.push({
                                processorName: processorNameContext,
                                title: `Linked from: ${sourcePageTitle || pageUrl}`,
                                url: absoluteUrl,
                                snippet: `Found on page: ${pageUrl}`,
                                documentType: 'linked_subprocessor_list_candidate',
                                sourceDpaUrl: pageUrl
                            });
                        }
                    }
                } catch (e) { /* Invalid URL, skip */ }
            }
        }
        // if (this.settings.verboseDebug && extractedLinks.length > 0) {
        //     console.log(`Extracted ${extractedLinks.length} potential subprocessor list URLs from ${pageUrl}`);
        // }
        return extractedLinks;
    }


    private async callRightBrainTask(taskId: string, taskVariables: Record<string, any>, rbToken: string): Promise<any | null> {
        if (!taskId) {
            new Notice("RightBrain Task ID is missing for the call.");
            console.error("ProcessorProcessor: Attempted to call RightBrain task with no Task ID.");
            return null;
        }
        if (!this.settings.rightbrainOrgId || !this.settings.rightbrainProjectId) {
            new Notice("RightBrain Org ID or Project ID not set. Cannot call task.");
            console.error("ProcessorProcessor: RB OrgID or ProjectID missing for task call.");
            return null;
        }
    
        const taskRunUrl = `${this.settings.rightbrainApiUrl}/org/${this.settings.rightbrainOrgId}/project/${this.settings.rightbrainProjectId}/task/${taskId}/run`;        const headers = {
            'Authorization': `Bearer ${rbToken}`,
            'Content-Type': 'application/json',
            'User-Agent': `ObsidianProcessorProcessorPlugin/${this.manifest.version}`
        };
    
        // --- THIS IS THE NEW LOGIC ---
        // Automatically wrap the provided variables in the required 'task_input' object.
        const payload = {
            task_input: taskVariables
        };
        
        if (this.settings.verboseDebug) {
            console.log(`[callRightBrainTask] Sending Request to Task ID ${taskId.substring(0,8)}... Payload:`, JSON.stringify(payload, null, 2));
        }
        
        try {
            const response = await requestUrl({
                url: taskRunUrl,
                method: 'POST',
                headers: headers,
                body: JSON.stringify(payload), // Send the newly constructed payload
                throw: false
            });
    
            if (response.json && (response.status === 200 || response.status === 201)) {
                if (this.settings.verboseDebug) {
                    console.log(`[callRightBrainTask] Success for Task ID ${taskId.substring(0,8)}... Full Response:`, JSON.stringify(response.json, null, 2));
                }
                return response.json; 
            } else {
                new Notice(`RightBrain Task ${taskId.substring(0,8)}... failed: ${response.status}. Check console.`, 7000);
                console.error(`RB Task Call [${taskId}] Error: ${response.status}`, response.text ? response.text.substring(0, 1000) : "No body", "Payload Sent:", payload);
                return null;
            }
        } catch (error: any) {
            new Notice(`Network error calling RightBrain Task ${taskId.substring(0,8)}.... Check console.`, 7000);
            console.error(`RB Task Call [${taskId}] Network Error:`, error, "Payload Sent:", payload);
            return null;
        }
    }


    private async verifySubprocessorListUrl(urlToVerify: string, processorName: string,rbToken: string): Promise<{ isList: boolean; isCurrent: boolean; isCorrectProcessor: boolean; reasoning: string; pageContent?: string } | null> {
        if (!this.settings.rightbrainVerifyUrlTaskId) {
            new Notice("RightBrain Verify URL Task ID is not configured. Cannot verify URL.");
            return null;
        }
        
        // The input parameter name for the RB task ('url_to_verify', 'url_content', etc.)
        // must match what the RB task definition expects.
        // Assuming the task expects something like: { "url_content": "https://..." }
        // And the url_fetcher input_processor is configured for "url_content"
        const taskInput = { 
            "url_content": urlToVerify,
            "expected_processor_name": processorName
        }; // This will be fetched by url_fetcher
    
        if (this.settings.verboseDebug) console.log(`Verifying URL ${urlToVerify} with RB Task ${this.settings.rightbrainVerifyUrlTaskId}. Input:`, JSON.stringify(taskInput));
        
        const taskResult = await this.callRightBrainTask(this.settings.rightbrainVerifyUrlTaskId, taskInput, rbToken);
    
        if (this.settings.verboseDebug) {
            console.log(`RB Verify Task [${this.settings.rightbrainVerifyUrlTaskId}] Full Result for URL ${urlToVerify}:`, JSON.stringify(taskResult, null, 2));
        }
    
        // Process the taskResult
        if (taskResult && typeof taskResult.response === 'object' && taskResult.response !== null) {
            const rbResponse = taskResult.response; 
            const isList = String(rbResponse.isSubprocessorList).toLowerCase() === 'true';
            const isCorrectProcessor = String(rbResponse.isCorrectProcessor).toLowerCase() === 'true';
            const isCurrent = String(rbResponse.isCurrentVersion).toLowerCase() === 'true';
            const reasoning = rbResponse.reasoning || "N/A";
    
            // Attempt to get pageContent if url_fetcher was used and passed it through
            let pageContent: string | undefined = undefined;
            // Check common places where fetched HTML might be stored by RB/url_fetcher
            if (taskResult.run_data && taskResult.run_data.submitted && 
                typeof taskResult.run_data.submitted.url_content === 'string' && 
                taskResult.run_data.submitted.url_content.toLowerCase().includes('<html')) { // Check if it looks like HTML
                // This assumes 'url_content' in 'submitted' data is the fetched HTML if url_fetcher was used.
                // This depends heavily on RB's internal structure for `run_wait_for_response`.
                pageContent = taskResult.run_data.submitted.url_content;
                if(this.settings.verboseDebug) console.log("Retrieved pageContent from run_data.submitted.url_content for verify task");
            } else if (typeof rbResponse.fetched_page_html === 'string') { // If LLM explicitly passes it back
                pageContent = rbResponse.fetched_page_html;
                if(this.settings.verboseDebug) console.log("Retrieved pageContent from rbResponse.fetched_page_html for verify task");
            } else if (typeof rbResponse.page_content === 'string') { // Another potential fallback
                 pageContent = rbResponse.page_content;
                 if(this.settings.verboseDebug) console.log("Retrieved pageContent from rbResponse.page_content (fallback) for verify task");
            }
            // More robust: if your RB task's input_processor (url_fetcher) stores its output in a known way within `taskResult.run_data.input_processor_outputs`, access it there.
            // e.g., if (taskResult.run_data?.input_processor_outputs?.url_content?.text_content) { pageContent = taskResult.run_data.input_processor_outputs.url_content.text_content; }

    
            if (this.settings.verboseDebug) {
                console.log(`RB Verify for ${urlToVerify}: List=${isList}, Current=${isCurrent}, Content available: ${!!pageContent}, Content snippet: ${pageContent ? pageContent.substring(0,100) + "..." : "N/A"}`);
            }
            return { isList, isCurrent: (isList && isCurrent), isCorrectProcessor, reasoning, pageContent };
        }
        if (this.settings.verboseDebug) {
            console.warn(`RB Verify task for ${urlToVerify} failed or returned unexpected response format. TaskResult:`, taskResult);
        }
        return null; // Verification failed or task output was not as expected
    }

    
    private async extractEntitiesFromPageContent(pageContent: string, rbToken: string): Promise<{ thirdPartySubprocessors: any[]; ownEntities: any[] } | null> {
        if (!this.settings.rightbrainExtractEntitiesTaskId) {
            new Notice("RB Extract Entities Task ID missing. Cannot extract from content.");
            return null;
        }
        if (!pageContent.trim()) {
            // if (this.settings.verboseDebug) console.log("Page content is empty, skipping entity extraction.");
            return { thirdPartySubprocessors: [], ownEntities: [] }; // Return empty if no content
        }

        // The input field name for the RB task must match the task definition.
        // e.g., if the task expects { "text_to_analyze": "..." }, use that here.
        const taskInput = { [this.settings.rightbrainExtractInputField]: pageContent };

        // if (this.settings.verboseDebug) console.log(`Extracting entities with RB Task ${this.settings.rightbrainExtractEntitiesTaskId}. Input snippet:`, pageContent.substring(0, 200) + "...");

        const taskResult = await this.callRightBrainTask(this.settings.rightbrainExtractEntitiesTaskId, taskInput, rbToken);

        // if (this.settings.verboseDebug && taskResult) {
        //     console.log(`RB Extract Entities Task Full Result:`, JSON.stringify(taskResult, null, 2));
        // }

        if (taskResult && typeof taskResult.response === 'object' && taskResult.response !== null) {
            const rbResponse = taskResult.response;
            // Access the arrays using the configured field names for third-party and own entities
            const thirdPartySubprocessors = rbResponse[this.settings.rightbrainExtractOutputThirdPartyField] || [];
            const ownEntities = rbResponse[this.settings.rightbrainExtractOutputOwnEntitiesField] || [];

            // Ensure they are arrays
            return {
                thirdPartySubprocessors: Array.isArray(thirdPartySubprocessors) ? thirdPartySubprocessors : [],
                ownEntities: Array.isArray(ownEntities) ? ownEntities : []
            };
        }
        // if (this.settings.verboseDebug) {
        //     console.warn(`RB Extract Entities task failed or returned unexpected response format. TaskResult:`, taskResult);
        // }
        return null;
    }

    private async updateDiscoveryStatus(file: TFile, status: 'complete' | 'incomplete' | 'skipped') {
        if (!file) return;
        await this.app.vault.process(file, (content) => {
            const updates: any = {
                'discovery-status': status
            };
            if (status === 'complete') {
                updates['last-discovered'] = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
            }
            return this.updateFrontmatter(content, updates, file.basename);
        });
    }

    private async buildAliasMap(): Promise<Map<string, { path: string, canonicalName: string }>> {
        const aliasMap = new Map<string, { path: string, canonicalName: string }>();
        const processorsFolder = this.app.vault.getAbstractFileByPath(this.settings.processorsFolderPath) as TFolder;
        if (!processorsFolder?.children) return aliasMap;

        for (const file of processorsFolder.children) {
            if (file instanceof TFile && file.extension === 'md') {
                const cache = this.app.metadataCache.getFileCache(file);
                const frontmatter = cache?.frontmatter || {};
                const canonicalName = frontmatter.aliases?.[0] || file.basename;
                const aliases = (frontmatter.aliases || []).map((a: string) => String(a).toLowerCase());
                aliases.push(file.basename.toLowerCase());
                
                for (const alias of new Set(aliases)) {
                    if (alias) {
                        aliasMap.set(alias as string, { path: file.path, canonicalName: canonicalName });
                    }
                }
            }
        }
        return aliasMap;
    }

            /**
     * Updates an existing RightBrain task by creating a new revision.
     * @param rbToken The RightBrain access token.
     * @param taskId The ID of the task to update.
     * @param taskDefinition An object containing the new configuration for the task revision.
     * @param creds Your RightBrain credentials.
     * @returns The updated task object or null if an error occurs.
     */

    private async updateRightBrainTask(rbToken: string, taskId: string, newRevisionPayload: any, taskName: string, creds: { apiUrl: string, orgId: string, projectId: string }): Promise<any | null> {
        const taskUrl = `${creds.apiUrl}/org/${creds.orgId}/project/${creds.projectId}/task/${taskId}`;
        const headers = {
            'Authorization': `Bearer ${rbToken}`,
            'Content-Type': 'application/json'
        };

        try {
            if (this.settings.verboseDebug) {
                console.log(`Creating revision for task '${taskName}' with payload:`, JSON.stringify(newRevisionPayload, null, 2));
            }
            
            // --- STEP 1: Create the new revision ---
            const createRevisionResponse = await requestUrl({
                url: taskUrl,
                method: 'POST',
                headers: headers,
                body: JSON.stringify(newRevisionPayload),
                throw: false
            });

            if (createRevisionResponse.status !== 200) {
                new Notice(`Error creating task revision for '${taskName}': ${createRevisionResponse.status} ${createRevisionResponse.text.substring(0, 100)}`, 10000);
                console.error(`Error creating task revision for '${taskName}':`, createRevisionResponse.status, createRevisionResponse.text);
                return null;
            } else {
                if (this.settings.verboseDebug) {
                    console.log(`Successfully created revision for '${taskName}'. Response:`, JSON.stringify(createRevisionResponse.json, null, 2));
                }
            }

            // --- STEP 2: Find the latest revision from the immediate response ---
            const updatedTaskData = createRevisionResponse.json;
            // FIX: Use `revisions` instead of `task_revisions`
            const latestRevision = updatedTaskData.revisions?.sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];

            if (!latestRevision) {
                new Notice(`Could not find the new revision for '${taskName}' in the API response.`, 7000);
                console.error("Could not find 'revisions' array in the response from creating a revision:", updatedTaskData);
                return null;
            }

            // --- STEP 3: Activate the new revision ---
            const activationPayload = {
                active_revisions: [{
                    task_revision_id: latestRevision.id,
                    weight: 1
                }]
            };

            const activateRevisionResponse = await requestUrl({
                url: taskUrl,
                method: 'POST',
                headers: headers,
                body: JSON.stringify(activationPayload),
                throw: false
            });
            
            if (activateRevisionResponse.status === 200) {
                    new Notice(`Successfully updated and activated task: '${taskName}'`);
                    return activateRevisionResponse.json;
            } else {
                new Notice(`Failed to activate new revision for '${taskName}': ${activateRevisionResponse.status}`, 7000);
                console.error(`Error activating revision for '${taskName}':`, activateRevisionResponse.status, activateRevisionResponse.text);
                return null;
            }

        } catch (error) {
            console.error(`Network error updating task '${taskName}':`, error);
            return null;
        }
    }

    async runDeduplicationForFolder(folder: TFolder) {
        new Notice(`Preparing to deduplicate pages in ${folder.path}...`);
        if (!this.settings.rightbrainDeduplicateSubprocessorsTaskId) {
            new Notice("Deduplication Task ID not set. Cannot proceed.");
            return;
        }
        const rbToken = await this.getRightBrainAccessToken();
        if (!rbToken) {
            new Notice("Could not get RightBrain token for deduplication.");
            return;
        }

        const files = folder.children.filter(f => f instanceof TFile && f.extension === 'md') as TFile[];
        if (files.length < 2) {
            new Notice("Not enough Markdown files in the folder to perform deduplication.");
            return;
        }

        const subprocessorPagesInfo: SubprocessorPageInfo[] = [];
        for (const file of files) {
            const fileCache = this.app.metadataCache.getFileCache(file);
            const frontmatter = fileCache?.frontmatter;
            const aliases = (frontmatter?.aliases && Array.isArray(frontmatter.aliases)) ? frontmatter.aliases.map(String) : [];
            if (frontmatter?.company_name) aliases.push(String(frontmatter.company_name)); // Include company_name if present
            aliases.push(file.basename); // Include basename as an alias

            subprocessorPagesInfo.push({
                file_path: file.path,
                page_name: file.basename, // Or a more canonical name from frontmatter if available
                aliases: Array.from(new Set(aliases.filter(a => a))) // Unique, non-empty aliases
            });
        }

        if (subprocessorPagesInfo.length < 2) {
            new Notice("Not enough processable pages with aliases found for deduplication.");
            return;
        }
        
        const taskInputPayload = {
            subprocessor_pages: subprocessorPagesInfo,
            // Optional: Add a threshold or other parameters if your RB task supports them
            // "similarity_threshold": 0.8 
        };

        new Notice(`Sending ${subprocessorPagesInfo.length} pages to RightBrain for deduplication analysis... This may take a while.`);
        // if(this.settings.verboseDebug) console.log("Deduplication payload:", JSON.stringify(taskInputPayload));

        const taskResult = await this.callRightBrainTask(this.settings.rightbrainDeduplicateSubprocessorsTaskId, taskInputPayload, rbToken);

        // if(this.settings.verboseDebug && taskResult) {
        //     console.log("Deduplication Task Full Result:", JSON.stringify(taskResult, null, 2));
        // }

        if (taskResult && taskResult.response && Array.isArray(taskResult.response.deduplication_results)) {
            const deduplicationResults: DeduplicationResultItem[] = taskResult.response.deduplication_results;
            if (deduplicationResults.length === 0) {
                new Notice("No duplicates found by RightBrain task.");
                return;
            }
            new Notice(`Deduplication analysis complete. Found ${deduplicationResults.length} potential duplicate sets. Processing merges...`);
            await this.processDeduplicationResults(deduplicationResults);
        } else {
            new Notice("Deduplication task failed or returned an unexpected response. Check console.");
            console.error("Deduplication task error. Response:", taskResult);
        }
    }


    async processDeduplicationResults(results: DeduplicationResultItem[]) {
        let mergeCount = 0;
        for (const resultSet of results) {
            if (!resultSet.survivor_file_path || resultSet.duplicate_file_paths.length === 0) {
                if (this.settings.verboseDebug) console.warn("Skipping invalid deduplication result set:", resultSet);
                continue;
            }
    
            const survivorFile = this.app.vault.getAbstractFileByPath(resultSet.survivor_file_path) as TFile;
            if (!survivorFile) {
                if (this.settings.verboseDebug) console.warn(`Survivor file not found: ${resultSet.survivor_file_path}`);
                continue;
            }
    
            const originalSurvivorContent = await this.app.vault.read(survivorFile);
            
            // --- Step 1: Gather all data from survivor and duplicates, while archiving duplicates ---
    
            const survivorCache = this.app.metadataCache.getFileCache(survivorFile);
            const allAliases = new Set<string>((survivorCache?.frontmatter?.aliases || []).map(String));
            allAliases.add(survivorFile.basename);
            const allRows = new Set<string>(this.extractClientTableRows(originalSurvivorContent));
    
            // <-- NEW: Ensure the archive folder exists.
            const archiveFolderPath = `${this.settings.processorsFolderPath}/_Archive`;
            await this.ensureFolderExists(archiveFolderPath);
    
                        // Track archived files for link updates
            const archivedFiles: { originalPath: string, archivedPath: string }[] = [];
            
            for (const dupFilePath of resultSet.duplicate_file_paths) {
                if (dupFilePath === survivorFile.path) continue;
                const dupFile = this.app.vault.getAbstractFileByPath(dupFilePath) as TFile;
                if (dupFile) {
                    const dupContent = await this.app.vault.read(dupFile);
                    const dupCache = this.app.metadataCache.getFileCache(dupFile);

                    (dupCache?.frontmatter?.aliases || []).map(String).forEach((alias: string) => allAliases.add(alias));
                    allAliases.add(dupFile.basename);
                    this.extractClientTableRows(dupContent).forEach(row => allRows.add(row));
                    
                    try {
                        // Generate unique archive path with version number
                        let archivePath = `${archiveFolderPath}/${dupFile.name}`;
                        let counter = 1;
                        while (this.app.vault.getAbstractFileByPath(archivePath)) {
                            const nameWithoutExt = dupFile.basename;
                            const ext = dupFile.extension;
                            archivePath = `${archiveFolderPath}/${nameWithoutExt} (v${counter}).${ext}`;
                            counter++;
                        }
                        
                        await this.app.vault.rename(dupFile, archivePath);
                        archivedFiles.push({ originalPath: dupFilePath, archivedPath: archivePath });
                    } catch (e) {
                        console.error(`Failed to move duplicate file ${dupFilePath} to archive:`, e);
                    }
                }
            }
    
            // --- Step 2: Rebuild the survivor file from scratch with merged data ---
    
            const fmRegex = /^---\s*\n([\s\S]*?)\n---\s*\n/;
            const match = originalSurvivorContent.match(fmRegex);
            const survivorBody = match ? originalSurvivorContent.substring(match[0].length) : originalSurvivorContent;
    
            const existingTags = new Set<string>((survivorCache?.frontmatter?.tags || []).map(String));
            // <-- NEW: Add a 'merged-processor' tag for easy searching.
            existingTags.add("merged-processor"); 
    
            let newFmString = "---\n";
            newFmString += `aliases: [${Array.from(allAliases).map(a => `"${a.replace(/"/g, '\\"')}"`).join(', ')}]\n`;
            newFmString += `tags: [${Array.from(existingTags).map(t => `"${t}"`).join(', ')}]\n`;
            newFmString += "---\n";
    
            let clientTableMd = "";
            if (allRows.size > 0) {
                clientTableMd += `| Primary Processor | Processing Function | Location | Source URL |\n`;
                clientTableMd += `|---|---|---|---|\n`;
                allRows.forEach(row => {
                    clientTableMd += `|${row}|\n`;
                });
            }
    
            const finalBody = this.ensureHeadingAndSection(survivorBody, "Used By", clientTableMd, null, null);
            let finalContent = newFmString + finalBody;
    
            // <-- NEW: Create the detailed merge record for the survivor's analysis log.
            const logDate = new Date().toISOString();
            const survivorLogPath = `${this.settings.analysisLogsFolderPath}/${this.sanitizeNameForFilePathAndAlias(survivorFile.basename).filePathName} Subprocessor Logs.md`;
            
            let mergeLogContent = `
    ---
    ### Deduplication Merge Event
    **Date:** ${logDate}
    **Survivor:** [[${survivorFile.path}|${survivorFile.basename}]]
    **RightBrain Reasoning:** ${resultSet.reasoning || "No reasoning provided."}
    
    **Archived Files (${resultSet.duplicate_file_paths.length}):**
    `;
            for (const dupFilePath of resultSet.duplicate_file_paths) {
                 const archivedPath = `${archiveFolderPath}/${dupFilePath.split('/').pop()}`;
                 mergeLogContent += `- [[${archivedPath}]]\n`;
            }
            await this.writeResultsToObsidianNote(survivorLogPath, mergeLogContent, 'ensure_exists_and_append', survivorFile.basename);
    
            // <-- NEW: Create and append the collapsible summary block to the survivor file itself.
            const mergeSummaryBlock = `
    <details>
    <summary>Merge History</summary>
    
    This note was the result of an automated deduplication event on ${new Date().toLocaleDateString()}.
    - **RightBrain Reasoning:** ${resultSet.reasoning || "N/A"}
    - For a full audit, see the [[${survivorLogPath}|Analysis Log]].
    
    </details>
    `;
            finalContent += `\n\n${mergeSummaryBlock}`;
    
            // --- Step 3: Write the final, enhanced content back to the survivor file ---
            await this.app.vault.modify(survivorFile, finalContent);
            
            // --- Step 4: Update all references to the archived files ---
            if (archivedFiles.length > 0) {
                // Create a mapping of archived files to their survivor
                const archivedToSurvivorMap = new Map<string, string>();
                archivedFiles.forEach(({ originalPath }) => {
                    archivedToSurvivorMap.set(originalPath, survivorFile.path);
                });
                await this.updateFileReferences(archivedFiles, archivedToSurvivorMap);
            }
            
            mergeCount++;
            new Notice(`Merged ${resultSet.duplicate_file_paths.length} duplicate(s) into ${survivorFile.basename}.`);
        }
    
        if (mergeCount > 0) {
            new Notice(`Deduplication finished. ${mergeCount} merge operations performed.`);
        } else {
            new Notice("Deduplication process finished, but no actionable merges were made.");
        }
    }

    async processManualMerge(survivorFile: TFile, duplicateFiles: TFile[]) {
        if (!survivorFile || duplicateFiles.length === 0) {
            new Notice("Merge cancelled: No survivor or duplicates selected.");
            return;
        }

        new Notice(`Merging ${duplicateFiles.length} file(s) into ${survivorFile.basename}...`, 6000);

        try {
            const originalSurvivorContent = await this.app.vault.read(survivorFile);
            
            // --- Step 1: Gather all data from survivor and duplicates ---
            const survivorCache = this.app.metadataCache.getFileCache(survivorFile);
            const allAliases = new Set<string>((survivorCache?.frontmatter?.aliases || []).map(String));
            allAliases.add(survivorFile.basename); // Add survivor's own name
            const allRows = new Set<string>(this.extractClientTableRows(originalSurvivorContent));

            for (const dupFile of duplicateFiles) {
                const dupContent = await this.app.vault.read(dupFile);
                const dupCache = this.app.metadataCache.getFileCache(dupFile);
                
                // Add duplicate's aliases and basename to the set
                (dupCache?.frontmatter?.aliases || []).map(String).forEach((alias: string) => allAliases.add(alias));
                allAliases.add(dupFile.basename);
                
                // Add duplicate's "Used By" table rows to the set
                this.extractClientTableRows(dupContent).forEach(row => allRows.add(row));
            }

            // --- Step 2: Rebuild the survivor file with merged data ---
            const fmRegex = /^---\s*\n([\s\S]*?)\n---\s*\n/;
            const match = originalSurvivorContent.match(fmRegex);
            const survivorBody = match ? originalSurvivorContent.substring(match[0].length) : originalSurvivorContent;

            // Rebuild frontmatter
            const existingTags = new Set<string>((survivorCache?.frontmatter?.tags || []).map(String));
            let newFmString = "---\n";
            newFmString += `aliases: [${Array.from(allAliases).map(a => `"${a.replace(/"/g, '\\"')}"`).join(', ')}]\n`;
            if (existingTags.size > 0) {
                newFmString += `tags: [${Array.from(existingTags).map(t => `"${t}"`).join(', ')}]\n`;
            }
            newFmString += "---\n";

            // Rebuild "Used By" table
            let clientTableMd = "";
            if (allRows.size > 0) {
                clientTableMd += `| Primary Processor | Processing Function | Location | Source URL |\n`;
                clientTableMd += `|---|---|---|---|\n`;
                allRows.forEach(row => {
                    clientTableMd += `|${row}|\n`;
                });
            }

            // Replace the "Used By" section within the survivor's body
            const finalBody = this.ensureHeadingAndSection(survivorBody, "Used By", clientTableMd, null, null);
            const finalContent = newFmString + finalBody;

            // --- Step 3: Write to survivor and archive duplicates ---
            await this.app.vault.modify(survivorFile, finalContent);
            
            // Archive duplicates instead of deleting them
            const archiveFolderPath = `${this.settings.processorsFolderPath}/_Archive`;
            await this.ensureFolderExists(archiveFolderPath);
            const archivedFiles: { originalPath: string, archivedPath: string }[] = [];
            
            for (const dupFile of duplicateFiles) {
                try {
                    // Generate unique archive path with version number
                    let archivePath = `${archiveFolderPath}/${dupFile.name}`;
                    let counter = 1;
                    while (this.app.vault.getAbstractFileByPath(archivePath)) {
                        const nameWithoutExt = dupFile.basename;
                        const ext = dupFile.extension;
                        archivePath = `${archiveFolderPath}/${nameWithoutExt} (v${counter}).${ext}`;
                        counter++;
                    }
                    
                    await this.app.vault.rename(dupFile, archivePath);
                    archivedFiles.push({ originalPath: dupFile.path, archivedPath: archivePath });
                } catch (e) {
                    console.error(`Failed to archive duplicate file ${dupFile.path}:`, e);
                    // Fallback to deletion if archiving fails
                    await this.app.vault.delete(dupFile);
                }
            }
            
            // Update references to archived files
            if (archivedFiles.length > 0) {
                // Create a mapping of archived files to their survivor
                const archivedToSurvivorMap = new Map<string, string>();
                archivedFiles.forEach(({ originalPath }) => {
                    archivedToSurvivorMap.set(originalPath, survivorFile.path);
                });
                await this.updateFileReferences(archivedFiles, archivedToSurvivorMap);
            }

            new Notice(`Successfully merged ${duplicateFiles.length} file(s) into ${survivorFile.basename}.`);

        } catch (error) {
            console.error("Error during manual merge:", error);
            new Notice("An error occurred during the merge. Check the developer console.");
        }
    }

    private extractClientTableRows(content: string): string[] {
        const rows: string[] = [];
        const lines = content.split('\n');
        let inUsedBySection = false;
        let tableHasStarted = false;

        for (const line of lines) {
            // Find the heading to start the process
            if (line.match(/^##+\s*Used By\s*$/i)) {
                inUsedBySection = true;
                tableHasStarted = false; // Reset in case of multiple "Used By" sections
                continue;
            }

            // Once we are in the right section, look for the table
            if (inUsedBySection) {
                const trimmedLine = line.trim();
                
                // Stop if we hit another heading of the same or higher level
                if (trimmedLine.startsWith('##')) {
                    inUsedBySection = false;
                    break; 
                }

                // Find the table separator to begin capturing rows
                if (trimmedLine.match(/^\|---\|/)) {
                    tableHasStarted = true;
                    continue;
                }

                // If the table has started, capture valid row content
                if (tableHasStarted && trimmedLine.startsWith('|') && trimmedLine.endsWith('|')) {
                    // Extract content between the first and last pipe
                    const match = trimmedLine.match(/^\|(.*)\|$/);
                    if (match && match[1]) {
                        // Check that it's a content row, not another separator
                        if (!match[1].match(/^---\|/)) {
                             rows.push(match[1]);
                        }
                    }
                } else if (tableHasStarted && trimmedLine !== "") {
                     // If the table had started and we find a non-empty, non-table row, assume the table has ended.
                     break;
                }
            }
        }
        return rows;
    }

    /**
     * Updates all file references in the vault when files are moved during deduplication.
     * This prevents broken links by updating all Obsidian links and file references.
     */
    private async updateFileReferences(archivedFiles: { originalPath: string, archivedPath: string }[], archivedToSurvivorMap?: Map<string, string>): Promise<void> {
        const allFiles = this.app.vault.getMarkdownFiles();
        
        for (const file of allFiles) {
            let content = await this.app.vault.read(file);
            let contentChanged = false;
            
            for (const { originalPath, archivedPath } of archivedFiles) {
                const originalName = originalPath.split('/').pop()?.replace('.md', '') || '';
                const archivedName = archivedPath.split('/').pop()?.replace('.md', '') || '';
                
                // Update Obsidian links: [[path|text]] or [[path]]
                const linkRegex = new RegExp(`\\[\\[${originalPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\|[^\\]]*)?\\]\\]`, 'g');
                if (linkRegex.test(content)) {
                    content = content.replace(linkRegex, (match, pipeAndText) => {
                        const newLink = `[[${archivedPath}${pipeAndText || ''}]]`;
                        contentChanged = true;
                        return newLink;
                    });
                }
                
                // Update Markdown links: [text](path) - specifically for subprocessor table links
                const markdownLinkRegex = new RegExp(`\\[([^\\]]+)\\]\\(${originalPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`, 'g');
                if (markdownLinkRegex.test(content)) {
                    content = content.replace(markdownLinkRegex, (match, linkText) => {
                        // For archived files, we should update the link to point to the survivor file
                        const survivorPath = archivedToSurvivorMap?.get(originalPath);
                        if (survivorPath) {
                            const newLink = `[${linkText}](${survivorPath})`;
                            contentChanged = true;
                            return newLink;
                        } else {
                            // If we can't find a survivor, just mark it as archived
                            const newLink = `[${linkText} (archived)](${archivedPath})`;
                            contentChanged = true;
                            return newLink;
                        }
                    });
                }
                
                // Update file name references in text (for cases where just the name is mentioned)
                const nameRegex = new RegExp(`\\b${originalName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
                if (nameRegex.test(content)) {
                    content = content.replace(nameRegex, (match) => {
                        contentChanged = true;
                        return `${match} (archived)`;
                    });
                }
            }
            
            if (contentChanged) {
                await this.app.vault.modify(file, content);
            }
        }
    }




    async discoverRecursively(initialProcessorName: string, initialProcessorFile?: TFile, maxDepth = 3) {
        new Notice(`Starting smart recursive discovery for: ${initialProcessorName}. Max depth: ${maxDepth}`, 10000);

        const aliasMap = await this.buildAliasMap();
        this.processedInCurrentRecursiveSearch = new Set<string>();
        const queue: Array<{ processorName: string, depth: number }> = [{ processorName: initialProcessorName, depth: 0 }];
        let discoveredCount = 0;
        let skippedCount = 0;
    
        while (queue.length > 0) {
            const current = queue.shift();
            if (!current) continue;
    
            const { processorName, depth } = current;
    
            // --- State-Aware Processing Check ---
            const existingEntity = aliasMap.get(processorName.toLowerCase());
            let currentProcessorFile = existingEntity ? this.app.vault.getAbstractFileByPath(existingEntity.path) as TFile : null;

            if (currentProcessorFile) {
                const cache = this.app.metadataCache.getFileCache(currentProcessorFile);
                if (cache?.frontmatter?.['discovery-status'] === 'complete' && cache?.frontmatter?.['last-discovered']) {
                    const lastRun = new Date(cache.frontmatter['last-discovered']);
                    const expiryDate = new Date();
                    expiryDate.setDate(expiryDate.getDate() - this.settings.discoveryCacheDays);
                    if (lastRun > expiryDate) {
                        if (this.settings.verboseDebug) console.log(`Skipping recently processed: ${processorName}`);
                        skippedCount++;
                        continue;
                    }
                }
            }
            
            new Notice(`Recursive (depth ${depth}): Processing ${processorName}...`);
            const { filePathName: sanitizedNameForTracking } = this.sanitizeNameForFilePathAndAlias(processorName);
            if (this.processedInCurrentRecursiveSearch.has(sanitizedNameForTracking)) continue;
            this.processedInCurrentRecursiveSearch.add(sanitizedNameForTracking);
            
            const isTopLevel = depth === 0;
            if (!currentProcessorFile) {
                currentProcessorFile = await this.ensureProcessorFile(processorName, true, isTopLevel);
            }
            if (!currentProcessorFile) continue;

            discoveredCount++;
            const searchData = await this.fetchProcessorSearchDataWithDiscovery(processorName);
    
            if (searchData?.collectedRelationships) {
                const directSubNames = Array.from(new Set(searchData.collectedRelationships
                    .filter(rel => rel.PrimaryProcessor === processorName && rel.RelationshipType === 'uses_subprocessor')
                    .map(rel => rel.SubprocessorName.trim())
                    .filter(name => name)));

                const mergeDecisionsLog: string[] = [];

                if (depth < maxDepth - 1) {
                    for (const subName of directSubNames) {
                        const sanitizedSubNameForTracking = this.sanitizeNameForFilePathAndAlias(subName).filePathName;
                        if (this.processedInCurrentRecursiveSearch.has(sanitizedSubNameForTracking)) continue;

                        const existingMapping = aliasMap.get(subName.toLowerCase());
                        let nameToQueue = subName;

                        if (existingMapping) {
                            nameToQueue = existingMapping.canonicalName;
                            if (subName !== nameToQueue) {
                                const decision = `Mapped discovered name "${subName}" to existing processor "${nameToQueue}".`;
                                mergeDecisionsLog.push(decision);
                            }
                        } else {
                            // It's a new entity, add it to our map for this run to catch duplicates within the same run
                            const { filePathName, originalNameAsAlias } = this.sanitizeNameForFilePathAndAlias(subName);
                            const newPath = `${this.settings.processorsFolderPath}/${filePathName}.md`;
                            aliasMap.set(subName.toLowerCase(), { path: newPath, canonicalName: originalNameAsAlias });
                        }

                        if (!queue.some(q => q.processorName === nameToQueue)) {
                            queue.push({ processorName: nameToQueue, depth: depth + 1 });
                        }
                    }
                }
                
                await this.persistSubprocessorInfo(processorName, currentProcessorFile, searchData, isTopLevel, mergeDecisionsLog);
                await this.updateDiscoveryStatus(currentProcessorFile, 'complete');
            } else {
                await this.updateDiscoveryStatus(currentProcessorFile, 'incomplete');
            }
    
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    
        new Notice(`Recursive discovery complete. Processed ${discoveredCount} entities, skipped ${skippedCount} recent ones.`, 10000);
        this.processedInCurrentRecursiveSearch.clear();
    }

    private openFileSelectorMergeModal() {
        const files = this.app.vault.getMarkdownFiles().filter(file => file.path.startsWith(normalizePath(this.settings.processorsFolderPath) + "/"));
        if (files.length < 2) {
            new Notice("There are not enough processor files to perform a merge.");
            return;
        }

        new FileSelectorMergeModal(this.app, files, (selectedFiles) => {
            // After the user selects files, we open the second modal to choose the survivor.
            new ForceMergeModal(this.app, selectedFiles, (survivor, duplicates) => {
                this.processManualMerge(survivor, duplicates);
            }).open();
        }).open();
    }

        /**
     * Writes a pre-defined configuration to the graph.json file.
     */
    async applyRecommendedGraphSettings() {
        // Define our ideal graph settings
        const graphSettings = {
            "collapse-filter": true,
            "search": `path:"${this.settings.processorsFolderPath}" -path:"${this.settings.processorsFolderPath}/_Archive"`, 
            "showTags": false,
            "showAttachments": false,
            "hideUnresolved": true,
            "showOrphans": false,
            "collapse-color-groups": true,
            "colorGroups": [
                {
                "query": "tag:#processor",
                "color": { "a": 1, "rgb": 14025728 } // Red
                },
                {
                "query": "tag:#subprocessor",
                "color": { "a": 1, "rgb": 6084182 } // Green
                },
                {
                "query": "tag:#merged-processor",
                "color": { "a": 1, "rgb": 6069962 } // Blue
                }
            ],
            "collapse-display": false,
            "showArrow": true, // Show link direction
            "textFadeMultiplier": -2.3,
            "nodeSizeMultiplier": 1.2,
            "lineSizeMultiplier": 1,
            "collapse-forces": false,
            "centerStrength": 0.5,
            "repelStrength": 12,
            "linkStrength": 1,
            "linkDistance": 250,
            "scale": 0.5,
            "close": false
        };

        const configPath = this.app.vault.configDir + '/graph.json';
        try {
            await this.app.vault.adapter.write(configPath, JSON.stringify(graphSettings, null, 2));
            new Notice("Recommended graph settings have been applied. Please reopen the graph view to see the changes.");
        } catch (error) {
            console.error("Failed to write graph settings:", error);
            new Notice("Error: Could not apply graph settings.");
        }
    }


}

// ----- MODAL CLASSES -----
class ManualInputModal extends Modal {
    processorName = '';
    listUrl = '';
    isPrimaryProcessor = true; // <-- New state variable, defaults to true
    onSubmit: (processorName: string, listUrl: string, isPrimary: boolean) => Promise<void>; // <-- Updated signature
    initialProcessorName?: string;

    constructor(app: App, onSubmit: (processorName: string, listUrl: string, isPrimary: boolean) => Promise<void>, initialProcessorName?: string) {
        super(app);
        this.onSubmit = onSubmit;
        this.initialProcessorName = initialProcessorName;
        if (this.initialProcessorName) {
            this.processorName = this.initialProcessorName;
        }
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: 'Manually Add Subprocessor List URL' });

        new Setting(contentEl)
            .setName('Processor name')
            .setDesc('Enter the name of the primary processor (e.g., OpenAI).')
            .addText(text => {
                text.setPlaceholder('Enter processor name')
                    .setValue(this.processorName)
                    .onChange(value => this.processorName = value)
                    .inputEl.setAttr("required", "true"); 
                if (this.initialProcessorName) {
                    text.setDisabled(true);
                }
            });

        new Setting(contentEl)
            .setName('Subprocessor list URL')
            .setDesc('Enter the direct URL to the subprocessor list or DPA page.')
            .addText(text =>
                text.setPlaceholder('https://example.com/subprocessors')
                    .setValue(this.listUrl)
                    .onChange(value => this.listUrl = value)
                    .inputEl.setAttr("required", "true"));

        // New "Is Primary" Toggle Setting
        new Setting(contentEl)
            .setName('Is a primary processor?')
            .setDesc('Enable this if you are initiating a search on this processor. Disable if you are adding a subprocessor of another entity.')
            .addToggle(toggle => toggle
                .setValue(this.isPrimaryProcessor)
                .onChange(value => this.isPrimaryProcessor = value));


        new Setting(contentEl)
            .addButton(button =>
                button.setButtonText('Process URL')
                    .setCta()
                    .onClick(() => {
                        // ... validation checks ...
                        this.close();
                        this.onSubmit(this.processorName, this.listUrl, this.isPrimaryProcessor); // <-- Pass the new flag
                    }));
    }

    onClose() {
        this.contentEl.empty();
    }
}

class SearchModal extends Modal {
    processorName = '';
    settings: ProcessorProcessorSettings; // To inform user about search method
    onSubmit: (processorName: string) => Promise<void>;

    constructor(app: App, settings: ProcessorProcessorSettings, onSubmit: (processorName: string) => Promise<void>) {
        super(app);
        this.settings = settings;
        this.onSubmit = onSubmit;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: 'Discover Subprocessors' });

        let searchMethodNote = "Search will be performed using available configured methods.";
        if (this.settings.serpApiKey) {
            searchMethodNote = "Search will primarily use SerpAPI.";
        } else if (this.settings.rightbrainOrgId && this.settings.rightbrainProjectId && this.settings.rightbrainDuckDuckGoSearchTaskId) {
            searchMethodNote = "SerpAPI key not found. Search will use DuckDuckGo via RightBrain.";
        } else {
            searchMethodNote = "Neither SerpAPI nor RightBrain DuckDuckGo search is fully configured. Discovery might be limited.";
        }
        contentEl.createEl('p', { text: searchMethodNote });


        new Setting(contentEl)
            .setName('Processor name')
            .setDesc('Enter the name of the processor to search for (e.g., Stripe).')
            .addText(text =>
                text.setPlaceholder('Enter processor name')
                    .setValue(this.processorName)
                    .onChange(value => this.processorName = value)
                    .inputEl.setAttr("required", "true"));

        new Setting(contentEl)
            .addButton(button =>
                button.setButtonText('Start Discovery')
                    .setCta()
                    .onClick(() => {
                        if (!this.processorName.trim()) {
                            new Notice("Processor Name is required.");
                            return;
                        }
                        this.close();
                        this.onSubmit(this.processorName);
                    }));
    }

    onClose() {
        this.contentEl.empty();
    }
}

class ManualTextEntryModal extends Modal {
    processorName = '';
    pastedText = '';
    isPrimaryProcessor = true; // <-- New state variable, defaults to true
    onSubmit: (processorName: string, pastedText: string, isPrimary: boolean) => Promise<void>; // <-- Updated signature
    initialProcessorName?: string;

    constructor(app: App, onSubmit: (processorName: string, pastedText: string, isPrimary: boolean) => Promise<void>, initialProcessorName?: string) {
        super(app);
        this.onSubmit = onSubmit;
        this.initialProcessorName = initialProcessorName;
        if (this.initialProcessorName) {
            this.processorName = this.initialProcessorName;
        }
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: 'Input Subprocessor List from Text' });

        new Setting(contentEl)
            .setName('Processor Name')
            .setDesc('Enter the name of the primary processor this text belongs to.')
            .addText(text => {
                text.setPlaceholder('Enter processor name')
                    .setValue(this.processorName)
                    .onChange(value => this.processorName = value)
                    .inputEl.setAttr("required", "true");
                if (this.initialProcessorName) {
                    text.setDisabled(true);
                }
            });
        

        new Setting(contentEl)
            .setName('Is a primary processor?')
            .setDesc('Enable this if you are initiating a search on this processor. Disable if you are adding a subprocessor of another entity.')
            .addToggle(toggle => toggle
                .setValue(this.isPrimaryProcessor)
                .onChange(value => this.isPrimaryProcessor = value));

        contentEl.createEl('p', { text: 'Paste the subprocessor list text below:' });
        
        const textArea = new TextAreaComponent(contentEl)
            .setPlaceholder('Paste text here...')
            .setValue(this.pastedText)
            .onChange(value => this.pastedText = value);
        textArea.inputEl.rows = 10;
        textArea.inputEl.addClass('processor-textarea');
        textArea.inputEl.setAttr("required", "true");

        new Setting(contentEl)
            .addButton(button =>
                button.setButtonText('Process Text')
                    .setCta()
                    .onClick(() => {
                        // ... validation checks ...
                        this.close();
                        this.onSubmit(this.processorName, this.pastedText, this.isPrimaryProcessor); // <-- Pass the new flag
                    }));
    }

    onClose() {
        this.contentEl.empty();
    }
}

class ForceMergeModal extends Modal {
    files: TFile[];
    onSubmit: (survivor: TFile, duplicates: TFile[]) => void;
    private survivor: TFile | null = null;

    constructor(app: App, files: TFile[], onSubmit: (survivor: TFile, duplicates: TFile[]) => void) {
        super(app);
        // Ensure files are sorted alphabetically for the user
        this.files = files.sort((a, b) => a.basename.localeCompare(b.basename));
        this.onSubmit = onSubmit;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: 'Force Merge Processors' });
        contentEl.createEl('p', { text: 'Select the file to keep (the "survivor"). All other selected files will be merged into it and then deleted.' });
    
        let mergeButton: ButtonComponent;
    
        const radioGroup = contentEl.createDiv();
    
        this.files.forEach(file => {
            const setting = new Setting(radioGroup)
                .setName(file.basename)
                .setDesc(file.path);
    
            // This creates a RADIO BUTTON for single selection
            const radio = createEl('input', {
                type: 'radio',
                cls: 'force-merge-radio'
            });
            radio.name = "survivor-selection";
            radio.value = file.path;
            radio.onchange = () => {
                this.survivor = file;
                // This correctly enables the merge button
                mergeButton.setDisabled(false).setCta();
            };
    
            setting.controlEl.appendChild(radio);
        });
    
        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText('Cancel')
                .onClick(() => this.close()))
            .addButton(btn => {
                mergeButton = btn;
                btn.setButtonText('Merge')
                    .setDisabled(true)
                    .onClick(() => {
                        if (this.survivor) {
                            const duplicates = this.files.filter(f => f.path !== this.survivor!.path);
                            this.close();
                            this.onSubmit(this.survivor, duplicates);
                        }
                    });
            });
    }

    onClose() {
        this.contentEl.empty();
    }
}

// class ConfirmationModal extends Modal {
//     constructor(app: App, private onConfirm: () => void) {
//         super(app);
//     }

//     onOpen() {
//         const { contentEl } = this;
//         contentEl.createEl('h2', { text: 'Overwrite Graph Settings?' });
//         contentEl.createEl('p', { text: 'This will replace your current global graph view settings with the recommended configuration for this plugin. Your existing settings will be lost.' });

//         new Setting(contentEl)
//             .addButton(btn => btn
//                 .setButtonText('Cancel')
//                 .onClick(() => {
//                     this.close();
//                 }))
//             .addButton(btn => btn
//                 .setButtonText('Yes, Overwrite')
//                 .setCta() // Makes the button stand out
//                 .onClick(() => {
//                     this.onConfirm();
//                     this.close();
//                 }));
//     }

//     onClose() {
//         this.contentEl.empty();
//     }
// }

class FileSelectorMergeModal extends Modal {
    files: TFile[];
    onSubmit: (selectedFiles: TFile[]) => void;
    private selectedFilePaths: Set<string> = new Set();

    constructor(app: App, files: TFile[], onSubmit: (selectedFiles: TFile[]) => void) {
        super(app);
        this.files = files.sort((a, b) => a.basename.localeCompare(b.basename));
        this.onSubmit = onSubmit;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: 'Select Files to Merge' });
        contentEl.createEl('p', { text: 'Choose two or more processor files from the list below.' });
    
        let nextButton: ButtonComponent;
    
        const checkboxGroup = contentEl.createDiv();
        checkboxGroup.addClass('processor-file-selector-list');
    
        this.files.forEach(file => {
            const setting = new Setting(checkboxGroup)
                .setName(file.basename)
                .setDesc(file.path);
            
            // This creates a CHECKBOX for multiple selections
            setting.addToggle(toggle => {
                toggle.onChange(value => {
                    if (value) {
                        this.selectedFilePaths.add(file.path);
                    } else {
                        this.selectedFilePaths.delete(file.path);
                    }
                    // This correctly enables the button when 2 or more are selected
                    nextButton.setDisabled(this.selectedFilePaths.size < 2);
                });
            });
        });
    
        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText('Cancel')
                .onClick(() => this.close()))
            .addButton(btn => {
                nextButton = btn;
                btn.setButtonText('Next: Select Survivor')
                    .setCta()
                    .setDisabled(true)
                    .onClick(() => {
                        const selectedFiles = this.files.filter(f => this.selectedFilePaths.has(f.path));
                        this.close();
                        this.onSubmit(selectedFiles);
                    });
            });
    }
}

class ModelSelectionModal extends Modal {
    selectedModelId = '';
    availableModels: LlmModel[] = [];
    plugin: ProcessorProcessorPlugin;
    onSubmit: (modelId: string) => Promise<void>;

    constructor(app: App, plugin: ProcessorProcessorPlugin, availableModels: LlmModel[], onSubmit: (modelId: string) => Promise<void>) {
        super(app);
        this.plugin = plugin;
        this.availableModels = availableModels;
        this.onSubmit = onSubmit;
        
        // Default to Gemini 2.5 Flash if available
        const defaultModel = availableModels.find(m => 
            m.alias.toLowerCase().includes('gemini') && 
            m.alias.toLowerCase().includes('flash')
        );
        this.selectedModelId = defaultModel?.id || availableModels[0]?.id || '';
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: 'Select Default Model' });
        contentEl.createEl('p', { 
            text: 'Choose a default AI model for all tasks. We recommend Gemini 2.5 Flash for cost-effectiveness and good performance. You can change individual task models later in the settings.' 
        });

        const modelGroup = contentEl.createDiv();
        modelGroup.addClass('model-selection-group');

        this.availableModels.forEach(model => {
            const setting = new Setting(modelGroup)
                .setName(model.alias)
                .setDesc(this.getModelDescription(model.alias));

            const radio = createEl('input', {
                type: 'radio',
                cls: 'model-selection-radio'
            });
            radio.name = "model-selection";
            radio.value = model.id;
            radio.checked = model.id === this.selectedModelId;
            radio.onchange = () => {
                this.selectedModelId = model.id;
            };

            setting.controlEl.appendChild(radio);
        });

        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText('Cancel')
                .onClick(() => this.close()))
            .addButton(btn => btn
                .setButtonText('Continue with Setup')
                .setCta()
                .onClick(async () => {
                    if (this.selectedModelId) {
                        this.close();
                        await this.onSubmit(this.selectedModelId);
                    } else {
                        new Notice('Please select a model to continue.');
                    }
                }));
    }

    private getModelDescription(alias: string): string {
        const lowerAlias = alias.toLowerCase();
        if (lowerAlias.includes('gemini') && lowerAlias.includes('flash')) {
            return 'Recommended: Fast, cost-effective, good for most tasks';
        } else if (lowerAlias.includes('gemini') && lowerAlias.includes('pro')) {
            return 'High performance, higher cost';
        } else if (lowerAlias.includes('claude')) {
            return 'Excellent reasoning, good for complex tasks';
        } else if (lowerAlias.includes('gpt')) {
            return 'Reliable performance, widely used';
        } else {
            return 'AI model for task processing';
        }
    }

    onClose() {
        this.contentEl.empty();
    }
}

class PasteEnvModal extends Modal {
    pastedText = '';
    plugin: ProcessorProcessorPlugin;

    constructor(app: App, plugin: ProcessorProcessorPlugin) {
        super(app);
        this.plugin = plugin;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: 'Complete Plugin Setup' });
        contentEl.createEl('p', { text: 'Paste the entire block of environment variables from your RightBrain dashboard below. This will save your credentials and then automatically create the necessary AI tasks in your project.' });

        const textArea = new TextAreaComponent(contentEl)
            .setPlaceholder('RB_ORG_ID="..."\nRB_PROJECT_ID="..."')
            .onChange(value => this.pastedText = value);
        textArea.inputEl.rows = 12;
        textArea.inputEl.addClass('processor-textarea');
        textArea.inputEl.addClass('processor-monospace');

        new Setting(contentEl)
            .addButton(button =>
                button.setButtonText('Begin Setup')
                    .setCta()
                    .onClick(() => {
                        if (this.pastedText.trim()) {
                            // This now triggers the entire setup flow
                            this.runFullSetup();
                            this.close();
                        } else {
                            new Notice("Text area is empty.");
                        }
                    }));
    }

    onClose() {
        this.contentEl.empty();
    }

    /**
     * Parses the pasted text, saves credentials, then proceeds to set up tasks.
     */
    async runFullSetup() {
        // --- Part 1: Parse and Save Credentials ---
        const lines = this.pastedText.trim().split('\n');
        const settingsToUpdate: Partial<ProcessorProcessorSettings> = {};
        
        const keyMap: { [key: string]: keyof ProcessorProcessorSettings } = {
            'RB_ORG_ID': 'rightbrainOrgId',
            'RB_PROJECT_ID': 'rightbrainProjectId',
            'RB_CLIENT_ID': 'rightbrainClientId',
            'RB_CLIENT_SECRET': 'rightbrainClientSecret',
            'RB_API_URL': 'rightbrainApiUrl',
            'RB_OAUTH2_URL': 'rightbrainOauth2Url'
        };
    
        for (const line of lines) {
            const parts = line.split('=');
            if (parts.length < 2) continue;
            const key = parts[0].trim();
            const value = parts.slice(1).join('=').trim().replace(/["']/g, '');
    
            if (key in keyMap && value) {
                const settingKey = keyMap[key];
                (settingsToUpdate as any)[settingKey] = value;
            }
        }
    
        if (!settingsToUpdate.rightbrainOrgId || !settingsToUpdate.rightbrainProjectId || !settingsToUpdate.rightbrainClientId || !settingsToUpdate.rightbrainClientSecret || !settingsToUpdate.rightbrainApiUrl || !settingsToUpdate.rightbrainOauth2Url) {
            new Notice("Setup failed. Pasted text is missing one or more required values.", 7000);
            return;
        }
        
        this.plugin.settings = Object.assign(this.plugin.settings, settingsToUpdate);
        await this.plugin.saveSettings();
        new Notice(`Credentials saved.`);
    
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // --- Part 2: Fetch Available Models ---
        new Notice("Fetching available models...");
        await this.plugin.updateLlmModelList(true);
        
        if (this.plugin.settings.llmModelList.length === 0) {
            new Notice("Failed to fetch available models. Please check your credentials and try again.", 7000);
            return;
        }
        
        // --- Part 3: Show Model Selection Modal ---
        new ModelSelectionModal(
            this.app, 
            this.plugin, 
            this.plugin.settings.llmModelList,
            async (selectedModelId) => {
                await this.completeSetupWithModel(selectedModelId, settingsToUpdate);
            }
        ).open();
    }

    /**
     * Completes the setup process with the selected model.
     */
    async completeSetupWithModel(selectedModelId: string, settingsToUpdate: Partial<ProcessorProcessorSettings>) {
        new Notice(`Selected model: ${this.plugin.settings.llmModelList.find(m => m.id === selectedModelId)?.alias || selectedModelId}`);
        
        // --- Part 4: Set up tasks with the selected model ---
        await this.plugin.setupRightBrainTasksWithModel({
            apiUrl: settingsToUpdate.rightbrainApiUrl!,
            oauthUrl: settingsToUpdate.rightbrainOauth2Url!,
            clientId: settingsToUpdate.rightbrainClientId!,
            clientSecret: settingsToUpdate.rightbrainClientSecret!,
            orgId: settingsToUpdate.rightbrainOrgId!,
            projectId: settingsToUpdate.rightbrainProjectId!
        }, selectedModelId);

        await this.plugin.applyRecommendedGraphSettings();
    }
}


// ----- SETTINGS TAB CLASS -----
class ProcessorProcessorSettingTab extends PluginSettingTab {
    plugin: ProcessorProcessorPlugin;

    constructor(app: App, plugin: ProcessorProcessorPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    async display(): Promise<void> {
        const { containerEl } = this;
        containerEl.empty();
        new Setting(containerEl).setName('Processor Processor Settings').setHeading();

        // --- API Keys & Credentials ---
        new Setting(containerEl).setName('API Keys & Credentials').setHeading();
        new Setting(containerEl)
            .setName('SerpAPI key')
            .setDesc('Your SerpAPI Key for Google search functionality.')
            .addText(text => text
                .setPlaceholder('Enter your SerpAPI key')
                .setValue(this.plugin.settings.serpApiKey)
                .onChange(async (value) => {
                    this.plugin.settings.serpApiKey = value;
                    await this.plugin.saveSettings();
                }));
        
        // --- RightBrain Configuration ---
        new Setting(containerEl).setName('RightBrain Task Configuration').setHeading();

        new Setting(containerEl)
            .setName('Automatically Synchronize Tasks on Load')
            .setDesc('If enabled, the plugin will check for and apply updates from its local task definitions on startup. Disable this if you prefer to manage and customize your tasks directly in the RightBrain dashboard without them being overwritten.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoSynchronizeTasks)
                .onChange(async (value) => {
                    this.plugin.settings.autoSynchronizeTasks = value;
                    await this.plugin.saveSettings();
                }));

        
        new Setting(containerEl)
            .setName('RB Extract Entities: Input Field Name')
            .setDesc('The parameter name your RB Extract Entities task expects for the input text (e.g., "page_text", "document_content").')
            .addText(text => text
                .setValue(this.plugin.settings.rightbrainExtractInputField)
                .setPlaceholder('e.g., page_text')
                .onChange(async (value) => {
                    this.plugin.settings.rightbrainExtractInputField = value;
                    await this.plugin.saveSettings();
                }));
        
        new Setting(containerEl)
            .setName('RB Extract Entities: Output Field (Third-Party)')
            .setDesc('The field name in your RB Extract Entities task\'s JSON output for the list of third-party subprocessors (e.g., "third_party_subprocessors").')
            .addText(text => text
                .setValue(this.plugin.settings.rightbrainExtractOutputThirdPartyField)
                .setPlaceholder('e.g., third_party_subprocessors')
                .onChange(async (value) => {
                    this.plugin.settings.rightbrainExtractOutputThirdPartyField = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('RB Extract Entities: Output Field (Own Entities)')
            .setDesc('The field name in your RB Extract Entities task\'s JSON output for the list of own/affiliated entities (e.g., "own_entities").')
            .addText(text => text
                .setValue(this.plugin.settings.rightbrainExtractOutputOwnEntitiesField)
                .setPlaceholder('e.g., own_entities')
                .onChange(async (value) => {
                    this.plugin.settings.rightbrainExtractOutputOwnEntitiesField = value;
                    await this.plugin.saveSettings();
                }));


        // --- General Settings ---
        new Setting(containerEl).setName('General Settings').setHeading();
        new Setting(containerEl)
            .setName('Create Pages for Own Entities')
            .setDesc('If enabled, separate Markdown pages will also be created for "own entities" identified during processing, not just third-party subprocessors.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.createPagesForOwnEntities)
                .onChange(async (value) => {
                    this.plugin.settings.createPagesForOwnEntities = value;
                    await this.plugin.saveSettings();
                }));
        
        new Setting(containerEl)
            .setName('Verbose Debug Logging')
            .setDesc('Enable detailed logging to the developer console for debugging purposes.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.verboseDebug)
                .onChange(async (value) => {
                    this.plugin.settings.verboseDebug = value;
                    await this.plugin.saveSettings();
                }));
        
        // maxResultsPerProcessor is not typically user-configurable if it's fixed for "stop on first true/true" logic
        // If it were, it would be an addText or addSlider
        new Setting(containerEl)
            .setName('Max Results Per Processor (Discovery)')
            .setDesc('Maximum search results to process for each processor during initial discovery. Currently, the logic stops on the first verified list, effectively making this 1.')
            .addText(text => text
                .setValue(this.plugin.settings.maxResultsPerProcessor.toString())
                .setDisabled(true) // Since the logic is hardcoded to stop on first verified
                .onChange(async (value) => {
                    // This setting is mostly informational due to current logic
                    // const num = parseInt(value);
                    // if (!isNaN(num) && num > 0) {
                    //     this.plugin.settings.maxResultsPerProcessor = num;
                    //     await this.plugin.saveSettings();
                    // }
                }));

        new Setting(containerEl)
            .setName('Mapping Depth')
            .setDesc('Set the maximum depth for the Map Subprocessor Relationships function (e.g., 2-5). Higher numbers will take much longer and use more API calls.')
            .addText(text => text
                .setPlaceholder('e.g., 3')
                .setValue(this.plugin.settings.maxRecursiveDepth.toString())
                .onChange(async (value) => {
                    const num = parseInt(value);
                    if (!isNaN(num) && num > 0) {
                        this.plugin.settings.maxRecursiveDepth = num;
                        await this.plugin.saveSettings();
                    }
                }));

        new Setting(containerEl)
                    .setName('Discovery Cache Duration (Days)')
                    .setDesc('How many days to consider a processor\'s data "fresh". A processor with a "complete" status discovered within this period will be skipped during recursive runs.')
                    .addText(text => text
                        .setPlaceholder('e.g., 30')
                        .setValue(this.plugin.settings.discoveryCacheDays.toString())
                        .onChange(async (value) => {
                            const num = parseInt(value);
                            if (!isNaN(num) && num >= 0) {
                                this.plugin.settings.discoveryCacheDays = num;
                                await this.plugin.saveSettings();
                            }
                        }));

        new Setting(containerEl)
            .setName('Processors Folder Path')
            .setDesc('Path to the folder where processor and subprocessor notes will be stored (e.g., "Third Parties/Processors").')
            .addText(text => text
                .setPlaceholder('e.g., Processors')
                .setValue(this.plugin.settings.processorsFolderPath)
                .onChange(async (value) => {
                    this.plugin.settings.processorsFolderPath = value || DEFAULT_SETTINGS.processorsFolderPath;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Analysis Logs Folder Path')
            .setDesc('Path to the folder where analysis log notes for each processor will be stored (e.g., "Compliance/Logs").')
            .addText(text => text
                .setPlaceholder('e.g., Analysis Logs')
                .setValue(this.plugin.settings.analysisLogsFolderPath)
                .onChange(async (value) => {
                    this.plugin.settings.analysisLogsFolderPath = value || DEFAULT_SETTINGS.analysisLogsFolderPath;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl).setName('RightBrain Model Configuration').setHeading();

        // --- THIS IS THE CORRECTED BLOCK ---
        new Setting(containerEl)
            .setDesc((() => {
                // Determine the correct dashboard URL from the saved API URL.
                const apiUrl = this.plugin.settings.rightbrainApiUrl || '';
                const dashboardUrl = (apiUrl.includes('stag') || apiUrl.includes('leftbrain'))
                    ? 'https://stag.leftbrain.me'
                    : 'https://app.rightbrain.ai';

                // We build the description inside a DocumentFragment to include a link.
                const fragment = new DocumentFragment();
                fragment.appendText('You can configure basic RightBrain settings here, or log in to the ');
                fragment.createEl('a', {
                    text: 'Rightbrain Dashboard',
                    href: dashboardUrl,
                    attr: { 'target': '_blank', 'rel': 'noopener noreferrer' } // Added rel for security
                });
                fragment.appendText(' for more fine-tuned control.');
                return fragment;
            })());        

        new Setting(containerEl)
            .setName("Refresh Model List")
            .setDesc("Fetch the latest available LLM models from your RightBrain project. The list is automatically cached for 24 hours.")
            .addButton(button => button
                .setButtonText("Refresh Now")
                .onClick(async () => {
                    await this.plugin.updateLlmModelList(true);
                    // Force a redraw of the settings tab to update the dropdowns
                    this.display(); 
                }));

        new Setting(containerEl)
            .setName("Synchronize Tasks with RightBrain")
            .setDesc("Force synchronization of all tasks with RightBrain. This will apply any model changes and update task configurations.")
            .addButton(button => button
                .setButtonText("Sync Now")
                .onClick(async () => {
                    new Notice("Synchronizing tasks with RightBrain...");
                    await this.plugin.synchronizeRightBrainTasks();
                }));

        const taskDefsForUI = [
            { name: "Verify Subprocessor List URL", settingKey: "verifyUrlModelId" },
            { name: "Extract Entities From Page Content", settingKey: "extractEntitiesModelId" },
            { name: "Deduplicate Subprocessors", settingKey: "deduplicateSubprocessorsModelId" },
            { name: "DDG SERP Parser", settingKey: "duckDuckGoSearchModelId" },
            { name: "Find DPA URL", settingKey: "findDpaModelId" },
            { name: "Find ToS URL", settingKey: "findTosModelId" },
            { name: "Find Security Page URL", settingKey: "findSecurityModelId" }
        ];

        const availableModels = this.plugin.settings.llmModelList;
        const defaultModel = availableModels.find(m => m.alias.toLowerCase().includes('gemini 1.5 flash'));

        // Get current task configurations from RightBrain to show actual models in use
        let currentTaskConfigs: Map<string, string> = new Map();
        
        if (this.plugin.settings.rightbrainOrgId && this.plugin.settings.rightbrainProjectId) {
            try {
                const rbToken = await this.plugin.getRightBrainAccessToken();
                if (rbToken) {
                    const creds = {
                        apiUrl: this.plugin.settings.rightbrainApiUrl,
                        oauthUrl: this.plugin.settings.rightbrainOauth2Url,
                        clientId: this.plugin.settings.rightbrainClientId,
                        clientSecret: this.plugin.settings.rightbrainClientSecret,
                        orgId: this.plugin.settings.rightbrainOrgId,
                        projectId: this.plugin.settings.rightbrainProjectId
                    };
                    
                    // Use the public method to get task list
                    const serverTasks = await this.plugin.listAllRightBrainTasks(rbToken, creds);
                    if (serverTasks) {
                        for (const task of serverTasks) {
                            const revisions = task.task_revisions || task.revisions;
                            if (revisions && revisions.length > 0) {
                                const latestRevision = revisions.sort((a: any, b: any) => 
                                    new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
                                )[0];
                                if (latestRevision.llm_model_id) {
                                    currentTaskConfigs.set(task.name, latestRevision.llm_model_id);
                                    if (this.plugin.settings.verboseDebug) {
                                        console.log(`Found current model for task '${task.name}': ${latestRevision.llm_model_id}`);
                                    }
                                }
                            }
                        }
                    }
                }
            } catch (error) {
                console.warn("Could not fetch current task configurations:", error);
            }
        }

        taskDefsForUI.forEach(task => {
            new Setting(containerEl)
                .setName(task.name)
                .setDesc(`Select the LLM to use for the "${task.name}" task.`)
                .addDropdown(dropdown => {
                    if (availableModels.length === 0) {
                        dropdown.addOption('', 'No models loaded. Refresh list or check credentials.');
                        dropdown.setDisabled(true);
                        return;
                    }

                    availableModels.forEach(model => {
                        dropdown.addOption(model.id, model.alias);
                    });

                    // Try to get the actual current model from RightBrain, fallback to saved setting, then default
                    const currentModelId = currentTaskConfigs.get(task.name) || 
                                        (this.plugin.settings as any)[task.settingKey] || 
                                        (defaultModel ? defaultModel.id : (availableModels.length > 0 ? availableModels[0].id : ''));
                    
                    if (this.plugin.settings.verboseDebug) {
                        console.log(`Setting dropdown for '${task.name}':`);
                        console.log(`  - From RightBrain: ${currentTaskConfigs.get(task.name) || 'not found'}`);
                        console.log(`  - From saved setting: ${(this.plugin.settings as any)[task.settingKey] || 'not set'}`);
                        console.log(`  - Final selection: ${currentModelId}`);
                    }
                    
                    dropdown.setValue(currentModelId);

                    dropdown.onChange(async (value) => {
                        (this.plugin.settings as any)[task.settingKey] = value;
                        await this.plugin.saveSettings();
                        new Notice(`${task.name} will now use ${dropdown.selectEl.options[dropdown.selectEl.selectedIndex].text}.`);
                        
                        // Trigger synchronization to apply the model change to RightBrain
                        if (this.plugin.settings.autoSynchronizeTasks) {
                            new Notice(`Applying model change for ${task.name} to RightBrain...`);
                            setTimeout(() => {
                                this.plugin.synchronizeRightBrainTasks();
                            }, 1000);
                        } else {
                            new Notice(`Model changed for ${task.name}. Run "Synchronize Tasks with RightBrain" to apply changes.`);
                        }
                    });
                });
        });
    }
}
