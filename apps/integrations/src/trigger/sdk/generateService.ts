import { IndentationText, NewLineKind, Project, QuoteKind } from "ts-morph";
import { Service } from "core/service/types";
import fs from "fs/promises";
import { generateInputOutputSchemas } from "generators/combineSchemas";
import { getTypesFromSchema } from "generators/generateTypes";
import { dirname } from "path";
import rimraf from "rimraf";

const appDir = require.main ? dirname(require.main.filename) : process.cwd();

export async function generateService(service: Service) {
  const basePath = `sdks/@trigger.dev/${service.service}`;

  //remove folder
  const absolutePath = `${appDir}/${basePath}/`;

  console.log(`Removing ${absolutePath}...`);
  rimraf.sync(absolutePath);

  console.log(`Generating SDK for ${service.service}...`);

  const project = new Project({
    manipulationSettings: {
      indentationText: IndentationText.TwoSpaces,
      newLineKind: NewLineKind.LineFeed,
      quoteKind: QuoteKind.Double,
      usePrefixAndSuffixTextForRename: false,
      useTrailingCommas: true,
    },
  });

  try {
    project.createDirectory(basePath);
    await generateTemplatedFiles(project, basePath, service);
    await generateFunctionsAndTypes(project, basePath, service);
    await project.save();
  } catch (e) {
    console.error(e);
  }
}

function toFriendlyTypeName(original: string) {
  //convert the input string to TitleCase, strip out any non alpha characters and strip out spaces
  return original
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, function (str: string) {
      return str.toUpperCase();
    })
    .replace(/[^a-zA-Z]/g, "")
    .replace(/\s/g, "");
}

async function generateTemplatedFiles(
  project: Project,
  basePath: string,
  service: Service
) {
  await createFileAndReplaceVariables(
    "package.json",
    project,
    basePath,
    service
  );
  await createFileAndReplaceVariables(
    "tsconfig.json",
    project,
    basePath,
    service
  );
  await createFileAndReplaceVariables("README.md", project, basePath, service);
  await createFileAndReplaceVariables(
    "tsup.config.ts",
    project,
    basePath,
    service
  );
  return;
}

async function createFileAndReplaceVariables(
  filename: string,
  project: Project,
  basePath: string,
  service: Service
) {
  const originalText = await fs.readFile(
    `src/trigger/sdk/templates/${filename}`,
    { encoding: "utf-8" }
  );

  //replace any text that matches {service.[key]} with the value from the service object
  const text = originalText.replace(
    /{service.([a-zA-Z0-9]+)}/g,
    (match: string, key: string) => {
      return (service as any)[key] as string;
    }
  );

  const file = project.createSourceFile(`${basePath}/${filename}`, text, {
    overwrite: true,
  });
  file.formatText();
  return;
}

async function generateFunctionsAndTypes(
  project: Project,
  basePath: string,
  service: Service
) {
  const { actions } = service;

  const typeDefinitions: Record<string, string> = {};
  const functions: Record<string, string> = {};
  //loop through actions
  for (const key in actions) {
    const action = actions[key];

    //generate schemas for input and output
    const name = toFriendlyTypeName(action.name);
    const schemas = generateInputOutputSchemas(action.spec, name);

    //generate types for input and output
    const inputTypeName = `${name}Input`;
    const inputType = await getTypesFromSchema(schemas.input, inputTypeName);
    typeDefinitions[inputTypeName] = inputType;
    const outputTypeName = `${name}Output`;
    const outputType = await getTypesFromSchema(schemas.output, outputTypeName);
    typeDefinitions[outputTypeName] = outputType;

    functions[action.name] = `
${action.description ? `/** ${action.description} */` : ""}
export async function ${action.name}(
  /** This key should be unique inside your workflow */
  key: string,
  /** The params for this call */
  params: ${inputTypeName}
): Promise<${outputTypeName}> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call ${action.name} outside of a trigger run");
  }

  const output = await run.performRequest(key, {
    version: "2",
    service: "${service.service}",
    endpoint: "${action.path}",
    params,
  });

  return output;
}
      `;
  }

  const typesFile = project.createSourceFile(
    `${basePath}/src/types.ts`,
    Object.values(typeDefinitions).join("\n\n"),
    {
      overwrite: true,
    }
  );
  typesFile.formatText();

  const functionsFile = project.createSourceFile(
    `${basePath}/src/index.ts`,
    `import { getTriggerRun } from "@trigger.dev/sdk";
      import { ${Object.keys(typeDefinitions).join(", ")} } from "./types";
      ${Object.values(functions).join("")}`,
    {
      overwrite: true,
    }
  );
  functionsFile.formatText();
}
