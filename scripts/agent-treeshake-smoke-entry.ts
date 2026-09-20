import { Agent } from "@myharness/agent-core";
import { createModels, fauxProvider } from "@myharness/ai";

const models = createModels();
const faux = fauxProvider();
models.setProvider(faux.provider);
const model = models.getModel(faux.provider.id, faux.provider.getModels()[0].id);
if (!model) throw new Error("Manual smoke-test model not found");

export const agent = new Agent({
	initialState: { model },
	streamFunction: models.streamSimple.bind(models),
});
