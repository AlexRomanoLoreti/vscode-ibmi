import fs from "fs";
import os from "os";
import util from "util";
import vscode from "vscode";
import { ConnectionConfiguration, GlobalConfiguration } from "../api/Configuration";
import { MemberParts } from "../api/IBMi";
import { SortOptions, SortOrder } from "../api/IBMiContent";
import { Search } from "../api/Search";
import { GlobalStorage } from '../api/Storage';
import { getMemberUri } from "../filesystems/qsys/QSysFs";
import { instance, setSearchResults } from "../instantiate";
import { t } from "../locale";
import { BrowserItem, BrowserItemParameters, FilteredItem, FocusOptions, IBMiFile, IBMiMember, IBMiObject, MemberItem, ObjectItem, SourcePhysicalFileItem } from "../typings";
import { editFilter } from "../webviews/filters";

const writeFileAsync = util.promisify(fs.writeFile);
const objectNamesLower = () => GlobalConfiguration.get<boolean>(`ObjectBrowser.showNamesInLowercase`);
const objectSortOrder = () => GlobalConfiguration.get<SortOrder>(`ObjectBrowser.sortObjectsByName`) ? `name` : `type`;

//https://code.visualstudio.com/api/references/icons-in-labels
const objectIcons = {
  'FILE': `database`,
  'CMD': `terminal`,
  'MODULE': `extensions`,
  'PGM': `file-binary`,
  'DTAARA': `clippy`,
  'DTAQ': `list-ordered`,
  'JOBQ': `checklist`,
  'LIB': `library`,
  'MEDDFN': `save-all`,
  'OUTQ': `symbol-enum`,
  'PNLGRP': `book`,
  'SBSD': `server-process`,
  'SRVPGM': `file-submodule`,
  'USRSPC': `chrome-maximize`,
  '': `circle-large-outline`
}

class ObjectBrowserItem extends BrowserItem {
  constructor(readonly filter: ConnectionConfiguration.ObjectFilters, label: string, params?: BrowserItemParameters) {
    super(label, params);
  }

  refresh(): void {
    vscode.commands.executeCommand(`code-for-ibmi.refreshObjectBrowser`, this);
  }

  reveal(options?: FocusOptions) {
    return vscode.commands.executeCommand<void>(`code-for-ibmi.revealInObjectBrowser`, this, options);
  }
}

class ObjectBrowser implements vscode.TreeDataProvider<BrowserItem> {
  private readonly emitter = new vscode.EventEmitter<BrowserItem | BrowserItem[] | undefined | null | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  async moveFilterInList(node: ObjectBrowserItem, filterMovement: `TOP` | `UP` | `DOWN` | `BOTTOM`) {
    const config = getConfig();
    if (config) {
      const filterName = node.filter.name;
      const objectFilters = config.objectFilters;
      const from = objectFilters.findIndex(filter => filter.name === filterName);
      let to;

      if (from === -1) throw `Filter ${filterName} is not found in list`;
      if (from === 0 && [`TOP`, `UP`].includes(filterMovement)) throw `Filter ${filterName} is at top of list`;
      if (from === objectFilters.length && [`DOWN`, `BOTTOM`].includes(filterMovement)) throw `Filter ${filterName} is at bottom of list`;

      switch (filterMovement) {
        case `TOP`:
          to = 0;
          break;
        case `UP`:
          to = from - 1;
          break;
        case `DOWN`:
          to = from + 1;
          break;
        case `BOTTOM`:
          to = objectFilters.length;
          break;
      }

      const filter = objectFilters[from];
      objectFilters.splice(from, 1);
      objectFilters.splice(to, 0, filter);
      config.objectFilters = objectFilters;
      await ConnectionConfiguration.update(config);
      this.autoRefresh();
    }
  }

  refresh(node?: BrowserItem) {
    this.emitter.fire(node);
  }

  autoRefresh(message?: string) {
    const autoRefresh = GlobalConfiguration.get(`autoRefresh`);
    if (autoRefresh) {
      if (message) {
        vscode.window.showInformationMessage(message);
      }

      this.refresh();
    }

    return autoRefresh;
  }

  getTreeItem(element: BrowserItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: BrowserItem): vscode.ProviderResult<BrowserItem[]> {
    return element?.getChildren?.() || this.getFilters();
  }

  getFilters(): BrowserItem[] {
    const config = getConfig();
    const filters = config.objectFilters;
    if (filters.length) {
      return filters.map(filter => new ObjectBrowserFilterItem(filter));
    } else {
      return [new CreateFilterItem()];
    }
  }

  getParent(element: BrowserItem): vscode.ProviderResult<BrowserItem> {
    return element.parent;
  }
}

class CreateFilterItem extends BrowserItem {
  constructor() {
    super(`${t('objectBrowser.createFilter')}...`, { icon: "add" });
    this.command = {
      command: `code-for-ibmi.maintainFilter`,
      title: `Create new filter`
    };
  }

  getChildren() {
    return [];
  }
}

class ObjectBrowserFilterItem extends ObjectBrowserItem {
  constructor(filter: ConnectionConfiguration.ObjectFilters) {
    super(filter, filter.name, { icon: filter.protected ? `lock-small` : '', state: vscode.TreeItemCollapsibleState.Collapsed });
    this.contextValue = `filter${filter.protected ? `_readonly` : ``}`;
    this.description = `${filter.library}/${filter.object}/${filter.member}.${filter.memberType || `*`} (${filter.types.join(`, `)})`;
  }

  async getChildren(): Promise<ObjectBrowserItem[]> {
    const lowerCased = objectNamesLower();
    return (await getContent().getObjectList(this.filter, objectSortOrder()))
      .map(object => {
        if (lowerCased === true) {
          object.name = object.name.toLocaleLowerCase();
          object.type = object.type.toLocaleLowerCase();
          object.attribute = object.attribute?.toLocaleLowerCase().trim();
        }

        return object.attribute?.toLocaleUpperCase() === `*PHY` ? new ObjectBrowserSourcePhysicalFileItem(this, object) : new ObjectBrowserObjectItem(this, object);
      });
  }
}

class ObjectBrowserSourcePhysicalFileItem extends ObjectBrowserItem implements SourcePhysicalFileItem {
  readonly sort: SortOptions = { order: "name", ascending: true };
  readonly path: string;

  constructor(parent: ObjectBrowserFilterItem, readonly sourceFile: IBMiFile) {
    super(parent.filter, sourceFile.name, { parent, icon: `file-directory`, state: vscode.TreeItemCollapsibleState.Collapsed });

    this.contextValue = `SPF${this.filter.protected ? `_readonly` : ``}`;
    this.description = sourceFile.text;

    this.path = [sourceFile.library, sourceFile.name].join(`/`);
  }

  sortBy(sort: SortOptions) {
    if (this.sort.order !== sort.order) {
      this.sort.order = sort.order;
      this.sort.ascending = true;
    }
    else {
      this.sort.ascending = !this.sort.ascending
    }
    this.description = `${this.sourceFile.text ? `${this.sourceFile.text} ` : ``}(sort: ${this.sort.order} ${this.sort.ascending ? `🔼` : `🔽`})`;
    this.reveal({ expand: true });
    this.refresh();
  }

  async getChildren(): Promise<BrowserItem[] | undefined> {
    const content = getContent();

    const writable = await content.checkObject({
      library: this.sourceFile.library,
      name: this.sourceFile.name,
      type: `*FILE`
    }, `*UPD`);

    try {
      const lowerCased = objectNamesLower();
      const members = (await content.getMemberList(this.sourceFile.library, this.sourceFile.name, this.filter.member, this.filter.memberType, this.sort))
        .map(member => {
          if (lowerCased === true) {
            member.file = member.file.toLocaleLowerCase();
            member.name = member.name.toLocaleLowerCase();
            member.extension = member.extension.toLocaleLowerCase();
          }
          return member;
        });

      await storeMemberList(this.path, members.map(member => `${member.name}.${member.extension}`));

      return members.map(member => new ObjectBrowserMemberItem(this, member, writable));
    } catch (e: any) {
      console.log(e);

      // Work around since we can't get the member list if the users QCCSID is not setup.
      const config = getConfig();
      if (config.enableSQL) {
        if (e && e.message && e.message.includes(`CCSID`)) {
          vscode.window.showErrorMessage(`Error getting member list. Disabling SQL and refreshing. It is recommended you reload. ${e.message}`, `Reload`).then(async (value) => {
            if (value === `Reload`) {
              await vscode.commands.executeCommand(`workbench.action.reloadWindow`);
            }
          });

          config.enableSQL = false;
          await ConnectionConfiguration.update(config);
          return this.getChildren();
        }
      } else {
        throw e;
      }
    }
  }
}

class ObjectBrowserObjectItem extends ObjectBrowserItem implements ObjectItem {
  readonly path: string;

  constructor(parent: ObjectBrowserFilterItem, readonly object: IBMiObject) {
    const type = object.type.startsWith(`*`) ? object.type.substring(1) : object.type;
    const icon = Object.entries(objectIcons).find(([key]) => key === type.toUpperCase())?.[1] || objectIcons[``];
    super(parent.filter, `${object.name}.${type}`, { icon, parent });

    this.path = [object.library, object.name].join(`/`);
    this.updateDescription();

    this.contextValue = `object.${type.toLowerCase()}${object.attribute ? `.${object.attribute}` : ``}${this.filter.protected ? `_readonly` : ``}`;

    this.resourceUri = vscode.Uri.from({
      scheme: `object`,
      path: `/${object.library}/${object.name}.${type}`,
      fragment: object.attribute
    });

    this.command = {
      command: `vscode.open`,
      title: `Open`,
      arguments: [this.resourceUri]
    };
  }

  updateDescription() {
    this.description = this.object.text.trim() + (this.object.attribute ? ` (${this.object.attribute})` : ``);
  }
}

class ObjectBrowserMemberItem extends ObjectBrowserItem implements MemberItem {
  readonly path: string;
  readonly sortBy: (sort: SortOptions) => void;

  constructor(parent: ObjectBrowserSourcePhysicalFileItem, readonly member: IBMiMember, writable: boolean) {
    const readOnly = parent.filter.protected || !writable;
    super(parent.filter, `${member.name}.${member.extension}`, { icon: readOnly ? `lock-small` : "", parent });
    this.contextValue = `member${readOnly ? `_readonly` : ``}`;
    this.description = member.text;

    this.resourceUri = getMemberUri(member, readOnly ? { readonly: true } : undefined);
    this.path = this.resourceUri.path;
    this.tooltip = `${this.path}`
      .concat(`${member.text ? `\n${t("text")}:\t\t${member.text}` : ``}`)
      .concat(`${member.lines != undefined ? `\n${t("lines")}:\t${member.lines}` : ``}`)
      .concat(`${member.created ? `\n${t("created")}:\t${member.created.toISOString().slice(0, 19).replace(`T`, ` `)}` : ``}`)
      .concat(`${member.changed ? `\n${t("changed")}:\t${member.changed.toISOString().slice(0, 19).replace(`T`, ` `)}` : ``}`);

    this.sortBy = parent.sortBy;

    this.command = {
      command: `vscode.open`,
      title: `Open Member`,
      arguments: [this.resourceUri]
    };
  }
}

export function initializeObjectBrowser(context: vscode.ExtensionContext) {
  const objectBrowser = new ObjectBrowser();
  const objectTreeViewer = vscode.window.createTreeView(
    `objectBrowser`, {
    treeDataProvider: objectBrowser,
    showCollapseAll: true
  });

  instance.onEvent(`connected`, () => objectBrowser.refresh());

  context.subscriptions.push(
    objectTreeViewer,

    vscode.commands.registerCommand(`code-for-ibmi.sortMembersByName`, (item: ObjectBrowserSourcePhysicalFileItem | ObjectBrowserMemberItem) => {
      item.sortBy({ order: "name" });
    }),

    vscode.commands.registerCommand(`code-for-ibmi.sortMembersByDate`, (item: ObjectBrowserSourcePhysicalFileItem | ObjectBrowserMemberItem) => {
      item.sortBy({ order: "date" });
    }),

    vscode.commands.registerCommand(`code-for-ibmi.createFilter`, async () => {
      await editFilter();
      objectBrowser.refresh();
    }),

    vscode.commands.registerCommand(`code-for-ibmi.createQuickFilter`, async () => {
      const config = getConfig();
      const objectFilters = config.objectFilters;

      const LIBRARY_REGEX = /^(?<lib>[^/.() ]+)\*$/;
      const FILTER_REGEX = /^(?<lib>[^/.() ]+)(\/(?<obj>[^/.() ]+))?(\/(?<mbr>[^/.() ]+))?(\.(?<mbrType>[^/.() ]+))?( \((?<objType>[^/.()]+)\))?$/;

      const newFilter = await vscode.window.showInputBox({
        prompt: `Enter filter as LIB* or LIB/OBJ/MBR.MBRTYPE (OBJTYPE) where each parameter is optional except the library`,
        value: ``,
        validateInput: newFilter => {
          const libraryRegex = LIBRARY_REGEX.exec(newFilter.toUpperCase());
          const filterRegex = FILTER_REGEX.exec(newFilter.toUpperCase());
          if (!libraryRegex && !filterRegex) return `Invalid filter: ${newFilter}. Use format LIB* or LIB/OBJ/MBR.MBRTYPE (OBJTYPE) where each parameter is optional except the library`;
        }
      });

      if (newFilter) {
        let regex = LIBRARY_REGEX.exec(newFilter.toUpperCase());
        const parsedFilter = regex?.groups;
        if (regex && parsedFilter) {
          const filter = {
            name: `Filter ${objectFilters.length + 1}`,
            library: `QSYS`,
            object: `${parsedFilter.lib}*`,
            types: [`*LIB`],
            member: `*`,
            memberType: `*`,
            protected: false
          }
          objectFilters.push(filter);
        } else {
          regex = FILTER_REGEX.exec(newFilter.toUpperCase());
          const parsedFilter = regex?.groups;
          if (regex && parsedFilter) {
            const filter = {
              name: `Filter ${objectFilters.length + 1}`,
              library: parsedFilter.lib || `QGPL`,
              object: parsedFilter.obj || `*`,
              types: [parsedFilter.objType || `*SRCPF`],
              member: parsedFilter.mbr || `*`,
              memberType: parsedFilter.mbrType || `*`,
              protected: false
            }
            objectFilters.push(filter);
          }
        }

        config.objectFilters = objectFilters;
        await ConnectionConfiguration.update(config);
        objectBrowser.refresh();
      }
    }),

    vscode.commands.registerCommand(`code-for-ibmi.copyFilter`, async (node: FilteredItem) => {
      await editFilter(node.filter, true);
      objectBrowser.refresh();
    }),

    vscode.commands.registerCommand(`code-for-ibmi.maintainFilter`, async (node?: FilteredItem) => {
      await editFilter(node?.filter);
      objectBrowser.refresh();
    }),

    vscode.commands.registerCommand(`code-for-ibmi.deleteFilter`, async (node: FilteredItem) => {
      const config = getConfig();
      const filter = node.filter;
      vscode.window.showInformationMessage(t(`objectBrowser.deleteFilter.infoMessage`, filter.name), t(`Yes`), t(`No`)).then(async (value) => {
        if (value === t(`Yes`)) {
          const index = config.objectFilters.findIndex(f => f.name === filter.name);

          if (index > -1) {
            config.objectFilters.splice(index, 1);
            await ConnectionConfiguration.update(config);
            objectBrowser.refresh();
          }
        }
      });
    }),

    vscode.commands.registerCommand(`code-for-ibmi.moveFilterUp`, (node: ObjectBrowserFilterItem) => objectBrowser.moveFilterInList(node, `UP`)),
    vscode.commands.registerCommand(`code-for-ibmi.moveFilterDown`, (node: ObjectBrowserFilterItem) => objectBrowser.moveFilterInList(node, `DOWN`)),
    vscode.commands.registerCommand(`code-for-ibmi.moveFilterToTop`, (node: ObjectBrowserFilterItem) => objectBrowser.moveFilterInList(node, `TOP`)),
    vscode.commands.registerCommand(`code-for-ibmi.moveFilterToBottom`, (node: ObjectBrowserFilterItem) => objectBrowser.moveFilterInList(node, `BOTTOM`)),

    vscode.commands.registerCommand(`code-for-ibmi.sortFilters`, async () => {
      const config = getConfig();
      config.objectFilters.sort((filter1, filter2) => filter1.name.toLowerCase().localeCompare(filter2.name.toLowerCase()));
      await ConnectionConfiguration.update(config);
      objectBrowser.autoRefresh();
    }),

    vscode.commands.registerCommand(`code-for-ibmi.refreshObjectBrowser`, async (item?: BrowserItem) => {
      objectBrowser.refresh(item);
    }),

    vscode.commands.registerCommand(`code-for-ibmi.revealInObjectBrowser`, async (item: BrowserItem, options?: FocusOptions) => {
      objectTreeViewer.reveal(item, options);
    }),

    vscode.commands.registerCommand(`code-for-ibmi.createMember`, async (node: ObjectBrowserSourcePhysicalFileItem, fullName?: string) => {
      const connection = getConnection();
      const toPath = (value: string) => `${node.path}/${value}`.toUpperCase();
      fullName = await vscode.window.showInputBox({
        prompt: t(`objectBrowser.createMember.prompt`),
        value: fullName,
        validateInput: (value) => {
          try {
            connection.parserMemberPath(toPath(value));
          } catch (e: any) {
            return e.toString();
          }
        }
      });

      if (fullName) {
        const fullPath = toPath(fullName);
        const member = connection.parserMemberPath(fullPath);
        const error = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t(`objectBrowser.createMember.progressTitle`, fullPath) }, async (progress) => {
          try {
            await connection.remoteCommand(
              `ADDPFM FILE(${member.library}/${member.file}) MBR(${member.name}) SRCTYPE(${member.extension.length > 0 ? member.extension : `*NONE`})`
            )

            if (GlobalConfiguration.get(`autoOpenFile`)) {
              vscode.commands.executeCommand(`vscode.open`, getMemberUri(member));
            }

            objectBrowser.refresh(node);
          }
          catch (e) {
            return e;
          }
        });

        if (error) {
          if (await vscode.window.showErrorMessage(t(`objectBrowser.createMember.errorMessage`, fullPath, error), t(`Retry`))) {
            vscode.commands.executeCommand(`code-for-ibmi.createMember`, node, fullName);
          }
        }
      }
    }),

    vscode.commands.registerCommand(`code-for-ibmi.copyMember`, async (node: ObjectBrowserMemberItem, fullPath) => {
      const connection = getConnection();
      const oldMember = node.member;
      fullPath = await vscode.window.showInputBox({
        prompt: t(`objectBrowser.copyMember.prompt`),
        value: node.path || fullPath,
        validateInput: (value) => {
          try {
            const memberPath = connection.parserMemberPath(value);
            if (memberPath.library === oldMember.library && memberPath.file === oldMember.file && memberPath.name === oldMember.name) {
              return t(`objectBrowser.copyMember.errorMessage`);
            }
          } catch (e: any) {
            return e.toString();
          }
        }
      });

      if (fullPath) {
        const memberPath = connection.parserMemberPath(fullPath);
        const error = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t(`objectBrowser.copyMember.progressTitle`, fullPath.toUpperCase()) }, async (progress) => {
          try {
            let newMemberExists = true;
            try {
              await connection.remoteCommand(
                `CHKOBJ OBJ(${memberPath.library}/${memberPath.file}) OBJTYPE(*FILE) MBR(${memberPath.name})`,
              )
            } catch (e) {
              if (String(e).includes(`CPF9815`)) {
                newMemberExists = false;
              }
            }

            if (newMemberExists) {
              const result = await vscode.window.showInformationMessage(t(`objectBrowser.copyMember.overwrite`, memberPath.name), { modal: true }, t(`Yes`), t(`No`))
              if (result === t(`Yes`)) {
                await connection.remoteCommand(
                  `RMVM FILE(${memberPath.library}/${memberPath.file}) MBR(${memberPath.name})`,
                )
              } else {
                throw t(`objectBrowser.copyMember.errorMessage2`, memberPath.name)
              }
            }

            try {
              await connection.remoteCommand(
                `CPYSRCF FROMFILE(${oldMember.library}/${oldMember.file}) TOFILE(${memberPath.library}/${memberPath.file}) FROMMBR(${oldMember.name}) TOMBR(${memberPath.name}) MBROPT(*REPLACE)`,
              )
            } catch (e) {
              // Ignore CPF2869 Empty member is not copied.
              if (!String(e).includes(`CPF2869`)) {
                throw (e)
              }
            }

            if (oldMember.extension !== memberPath.extension) {
              await connection.remoteCommand(
                `CHGPFM FILE(${memberPath.library}/${memberPath.file}) MBR(${memberPath.name}) SRCTYPE(${memberPath.extension.length > 0 ? memberPath.extension : `*NONE`})`,
              );
            }

            if (GlobalConfiguration.get(`autoOpenFile`)) {
              vscode.commands.executeCommand(`vscode.open`, getMemberUri(memberPath));
            }

            if (oldMember.library.toLocaleLowerCase() === memberPath.library.toLocaleLowerCase()) {
              if (oldMember.file.toLocaleLowerCase() === memberPath.file.toLocaleLowerCase()) {
                objectBrowser.refresh(node.parent);
              }
              else {
                objectBrowser.refresh(node.parent?.parent);
              }
            }
            else {
              objectBrowser.autoRefresh();
            }
          } catch (e) {
            return e;
          }
        });

        if (error) {
          if (await vscode.window.showErrorMessage(t(`objectBrowser.copyMember.errorMessage3`, fullPath, error), t(`Retry`))) {
            vscode.commands.executeCommand(`code-for-ibmi.copyMember`, node, fullPath);
          }
        }
      }
    }),
    vscode.commands.registerCommand(`code-for-ibmi.deleteMember`, async (node: ObjectBrowserMemberItem) => {
      let result = await vscode.window.showWarningMessage(t(`objectBrowser.deleteMember.warningMessage`, node.path), t(`Yes`), t(`Cancel`));

      if (result === t(`Yes`)) {
        const connection = getConnection();
        const { library, file, name } = connection.parserMemberPath(node.path);

        try {
          await connection.remoteCommand(
            `RMVM FILE(${library}/${file}) MBR(${name})`,
          );

          vscode.window.showInformationMessage(t(`objectBrowser.deleteMember.infoMessage`, node.path));

          objectBrowser.refresh(node.parent);
        } catch (e) {
          vscode.window.showErrorMessage(t(`objectBrowser.deleteMember.errorMessage`, e));
        }

        //Not sure how to remove the item from the list. Must refresh - but that might be slow?
      }
    }),
    vscode.commands.registerCommand(`code-for-ibmi.updateMemberText`, async (node: ObjectBrowserMemberItem) => {
      const connection = getConnection();
      const { library, file, name, basename } = connection.parserMemberPath(node.path);
      const oldText = node.member.text;
      const newText = await vscode.window.showInputBox({
        value: oldText,
        prompt: t(`objectBrowser.updateMemberText.prompt`, basename)
      });

      if (newText && newText !== oldText) {
        const escapedText = newText.replace(/'/g, `''`);
        const connection = getConnection();

        try {
          await connection.remoteCommand(
            `CHGPFM FILE(${library}/${file}) MBR(${name}) TEXT('${escapedText}')`,
          );

          node.description = newText;
          objectBrowser.refresh(node);
        } catch (e) {
          vscode.window.showErrorMessage(t(`objectBrowser.updateMemberText.errorMessage`, e));
        }
      }
    }),
    vscode.commands.registerCommand(`code-for-ibmi.renameMember`, async (node: ObjectBrowserMemberItem) => {
      const connection = getConnection();
      const oldMember = connection.parserMemberPath(node.path);
      const library = oldMember.library;
      const sourceFile = oldMember.file;
      let newBasename: string | undefined = oldMember.basename;
      let newMember: MemberParts | undefined;
      let newNameOK;

      do {
        newBasename = await vscode.window.showInputBox({
          value: newBasename,
          prompt: t(`objectBrowser.renameMember.prompt`, oldMember.basename),
          validateInput: value => value.toUpperCase() === oldMember.basename ? t("objectBrowser.renameMember.invalid.input") : undefined
        });

        if (newBasename) {
          newNameOK = true;
          try {
            newMember = connection.parserMemberPath(library + `/` + sourceFile + `/` + newBasename);
          } catch (e: any) {
            newNameOK = false;
            vscode.window.showErrorMessage(e);
          }

          if (newMember) {
            try {
              if (oldMember.name !== newMember.name) {
                await connection.remoteCommand(
                  `RNMM FILE(${library}/${sourceFile}) MBR(${oldMember.name}) NEWMBR(${newMember.name})`,
                );
              }
              if (oldMember.extension !== newMember.extension) {
                await connection.remoteCommand(
                  `CHGPFM FILE(${library}/${sourceFile}) MBR(${newMember.name}) SRCTYPE(${newMember.extension.length > 0 ? newMember.extension : `*NONE`})`,
                );
              }

              objectBrowser.refresh(node.parent);
            } catch (e) {
              newNameOK = false;
              vscode.window.showErrorMessage(t(`objectBrowser.renameMember.errorMessage`, e));
            }
          }
        }
      } while (newBasename && !newNameOK)
    }),

    vscode.commands.registerCommand(`code-for-ibmi.uploadAndReplaceMemberAsFile`, async (node: MemberItem) => {
      const contentApi = getContent();

      const originPath = await vscode.window.showOpenDialog({ defaultUri: vscode.Uri.file(os.homedir()) });

      if (originPath) {
        const connection = getConnection();
        const { asp, library, file, name } = connection.parserMemberPath(node.path);
        const data = fs.readFileSync(originPath[0].fsPath, `utf8`);

        try {
          contentApi.uploadMemberContent(asp, library, file, name, data);
          vscode.window.showInformationMessage(t(`objectBrowser.uploadAndReplaceMemberAsFile.infoMessage`));
        } catch (e) {
          vscode.window.showErrorMessage(t(`objectBrowser.uploadAndReplaceMemberAsFile.errorMessage`, e));
        }
      }

    }),

    vscode.commands.registerCommand(`code-for-ibmi.downloadMemberAsFile`, async (node: MemberItem) => {
      const contentApi = getContent();
      const connection = getConnection();

      const { asp, library, file, name: member, basename } = connection.parserMemberPath(node.path);

      const memberContent = await contentApi.downloadMemberContent(asp, library, file, member);

      let localFilepath = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(os.homedir() + `/` + basename) });

      if (localFilepath) {
        let localPath = localFilepath.path;
        if (process.platform === `win32`) {
          //Issue with getFile not working properly on Windows
          //when there is a / at the start.
          if (localPath[0] === `/`) {
            localPath = localPath.substring(1);
          }
        }

        try {
          await writeFileAsync(localPath, memberContent, `utf8`);
          vscode.window.showInformationMessage(t(`objectBrowser.downloadMemberContent.infoMessage`));
        } catch (e) {
          vscode.window.showErrorMessage(t(`objectBrowser.downloadMemberContent.errorMessage`, e));
        }
      }
    }),

    vscode.commands.registerCommand(`code-for-ibmi.searchSourceFile`, async (node?: SourcePhysicalFileItem) => {
      const parameters = {
        path: node?.path || ``,
        filter: node?.filter
      }

      if (!parameters.path) {
        const connection = getConnection();
        const input = await vscode.window.showInputBox({
          prompt: t(`objectBrowser.searchSourceFile.prompt`),
          title: t(`objectBrowser.searchSourceFile.title`),
          validateInput: (input) => {
            input = input.trim();
            const path = input.split(`/`);
            let checkPath;
            if (path.length > 3) {
              return t(`objectBrowser.searchSourceFile.invalidForm`)
            } else if (path.length > 2) {                 // Check member
              let checkMember = path[2].replace(/[*]/g, ``).split(`.`);
              checkMember[0] = checkMember[0] !== `` ? checkMember[0] : `a`;
              checkPath = path[0] + `/` + path[1] + `/` + checkMember[0] + `.` + (checkMember.length > 1 ? checkMember[1] : ``);
            } else if (path.length > 1) {                 // Check filename
              checkPath = input + (path[path.length - 1] === `` ? `a` : ``) + `/a.b`;
            } else {                                      // Check library
              checkPath = input + (path[path.length - 1] === `` ? `a` : ``) + `/a/a.a`;
            }
            if (checkPath) {
              try {
                connection.parserMemberPath(checkPath);
              } catch (e: any) {
                return e;
              }
            }
          }
        });

        if (input) {
          const path = input.trim().toUpperCase().split(`/`);
          parameters.path = [path[0], path[1]].join('/');
        }
      }

      if (parameters.path) {
        const config = getConfig();
        const storage = instance.getStorage();

        const pathParts = parameters.path.split(`/`);
        if (pathParts[1] !== `*ALL`) {
          const aspText = ((config.sourceASP && config.sourceASP.length > 0) ? t(`objectBrowser.searchSourceFile.aspText`, config.sourceASP) : ``);

          let list = GlobalStorage.get().getPreviousSearchTerms();
          const listHeader: vscode.QuickPickItem[] = [
            { label: t(`objectBrowser.searchSourceFile.previousSearches`), kind: vscode.QuickPickItemKind.Separator }
          ];
          const clearList = t(`clearList`);
          const clearListArray = [{ label: ``, kind: vscode.QuickPickItemKind.Separator }, { label: clearList }];

          const quickPick = vscode.window.createQuickPick();
          quickPick.items = list.length > 0 ? listHeader.concat(list.map(term => ({ label: term }))).concat(clearListArray) : [];
          quickPick.placeholder = list.length > 0 ? t(`objectBrowser.searchSourceFile.placeholder`) : t(`objectBrowser.searchSourceFile.placeholder2`);
          quickPick.title = t(`objectBrowser.searchSourceFile.title2`, parameters.path, aspText);

          quickPick.onDidChangeValue(() => {
            if (quickPick.value === ``) {
              quickPick.items = listHeader.concat(list.map(term => ({ label: term }))).concat(clearListArray);
            } else if (!list.includes(quickPick.value)) {
              quickPick.items = [{ label: quickPick.value }].concat(listHeader)
                .concat(list.map(term => ({ label: term })))
            }
          })

          quickPick.onDidAccept(async () => {
            const searchTerm = quickPick.activeItems[0].label;
            if (searchTerm) {
              if (searchTerm === clearList) {
                GlobalStorage.get().setPreviousSearchTerms([]);
                list = [];
                quickPick.items = [];
                quickPick.placeholder = t(`objectBrowser.searchSourceFile.placeholder2`);
                vscode.window.showInformationMessage(t(`clearedList`));
                quickPick.show();
              } else {
                quickPick.hide();
                list = list.filter(term => term !== searchTerm);
                list.splice(0, 0, searchTerm);
                GlobalStorage.get().setPreviousSearchTerms(list);
                await doSearchInSourceFile(searchTerm, parameters.path, parameters.filter);
              }
            }
          });
          
          quickPick.onDidHide(() => quickPick.dispose());
          quickPick.show();

        } else {
          vscode.window.showErrorMessage(t(`objectBrowser.searchSourceFile.errorMessage`));
        }
      }
    }),

    vscode.commands.registerCommand(`code-for-ibmi.createLibrary`, async () => {
      const config = getConfig();
      const connection = getConnection();

      const newLibrary = await vscode.window.showInputBox({
        prompt: t(`objectBrowser.createLibrary.prompt`),
        validateInput: (library => library.length > 10 ? t(`objectBrowser.createLibrary.errorMessage2`) : undefined)
      });

      if (newLibrary) {

        const filters = config.objectFilters;

        try {
          await connection.remoteCommand(
            `CRTLIB LIB(${newLibrary})`
          );
        } catch (e) {
          vscode.window.showErrorMessage(t(`objectBrowser.createLibrary.errorMessage`, newLibrary, e));
          return;
        }

        filters.push({
          name: newLibrary,
          library: newLibrary,
          object: `*ALL`,
          types: [`*ALL`],
          member: `*`,
          memberType: `*`,
          protected: false
        });

        config.objectFilters = filters;
        ConnectionConfiguration.update(config);
        const autoRefresh = objectBrowser.autoRefresh();

        // Add to library list ?
        await vscode.window.showInformationMessage(t(`objectBrowser.createLibrary.infoMessage`), t(`Yes`), t(`No`))
          .then(async result => {
            switch (result) {
              case t(`Yes`):
                await vscode.commands.executeCommand(`code-for-ibmi.addToLibraryList`, newLibrary);
                if (autoRefresh) {
                  vscode.commands.executeCommand(`code-for-ibmi.refreshLibraryListView`);
                }
                break;
            }
          });
      }
    }),

    vscode.commands.registerCommand(`code-for-ibmi.createSourceFile`, async (node: ObjectBrowserFilterItem) => {
      const filter = node.filter;
      const fileName = await vscode.window.showInputBox({
        prompt: t(`objectBrowser.createSourceFile.prompt`),
        validateInput: (fileName => fileName.length > 10 ? t('objectBrowser.createSourceFile.errorMessage2') : undefined)
      });

      if (fileName) {
        const connection = getConnection();
        try {
          const library = filter.library;
          const uriPath = `${library}/${fileName.toUpperCase()}`

          vscode.window.showInformationMessage(t(`objectBrowser.createSourceFile.infoMessage`, uriPath));

          await connection.remoteCommand(
            `CRTSRCPF FILE(${uriPath}) RCDLEN(112)`
          );

          objectBrowser.refresh(node);
        } catch (e) {
          vscode.window.showErrorMessage(t(`objectBrowser.createSourceFile.errorMessage`, e));
        }
      }
    }),

    vscode.commands.registerCommand(`code-for-ibmi.changeObjectDesc`, async (node: ObjectBrowserObjectItem) => {
      let newText = node.object.text;
      let newTextOK;
      do {
        newText = await vscode.window.showInputBox({
          prompt: t(`objectBrowser.changeObjectDesc.prompt`, node.path),
          value: newText,
          validateInput: newText => {
            return newText.length <= 50 ? null : t(`objectBrowser.changeObjectDesc.errorMessage`);
          }
        }) || "";

        if (newText) {
          const escapedText = newText.replace(/'/g, `''`).replace(/`/g, `\\\``);
          const connection = getConnection();

          try {
            newTextOK = true;
            await connection.remoteCommand(
              `CHGOBJD OBJ(${node.path}) OBJTYPE(${node.object.type}) TEXT(${newText.toUpperCase() !== `*BLANK` ? `'${escapedText}'` : `*BLANK`})`
            );

            node.object.text = newText;
            node.updateDescription();
            objectBrowser.refresh(node);
            vscode.window.showInformationMessage(t(`objectBrowser.changeObjectDesc.infoMessage`, node.path, node.object.type.toUpperCase()));
          } catch (e) {
            vscode.window.showErrorMessage(t(`objectBrowser.changeObjectDesc.errorMessage2`, node.path, e));
            newTextOK = false;
          }
        }
      } while (newText && !newTextOK)
    }),

    vscode.commands.registerCommand(`code-for-ibmi.copyObject`, async (node: ObjectBrowserObjectItem) => {
      let newPath = node.path;
      let newPathOK;
      do {
        newPath = await vscode.window.showInputBox({
          prompt: t(`objectBrowser.copyObject.prompt`),
          value: newPath,
          validateInput: newPath => {
            let splitPath = newPath.split(`/`);
            if (splitPath.length != 2) return t(`objectBrowser.copyObject.errorMessage`, newPath);
            if (splitPath[0].length > 10) return t(`objectBrowser.copyObject.errorMessage2`);
            if (splitPath[1].length > 10) return t(`objectBrowser.copyObject.errorMessage3`);
          }
        }) || "";

        if (newPath) {
          const [oldLibrary, oldObject] = node.path.split(`/`);
          const escapedPath = newPath.replace(/'/g, `''`).replace(/`/g, `\\\``);
          const [newLibrary, newObject] = escapedPath.split(`/`);
          const connection = getConnection();

          try {
            newPathOK = true;
            await connection.remoteCommand(
              node.object.type === `LIB` ?
                `CPYLIB FROMLIB(${oldObject}) TOLIB(${newObject})` :
                `CRTDUPOBJ OBJ(${oldObject}) FROMLIB(${oldLibrary}) OBJTYPE(${node.object.type}) TOLIB(${newLibrary}) NEWOBJ(${newObject})`
            );

            if (oldLibrary.toLocaleLowerCase() === newLibrary.toLocaleLowerCase()) {
              objectBrowser.refresh(node.parent);
            }
            else if (!objectBrowser.autoRefresh(t(`objectBrowser.copyObject.infoMessage`, node.path, node.object.type.toUpperCase(), escapedPath))) {
              vscode.window.showInformationMessage(t(`objectBrowser.copyObject.infoMessage2`, node.path, node.object.type.toUpperCase(), escapedPath));
            }
          } catch (e) {
            vscode.window.showErrorMessage(t(`objectBrowser.copyObject.errorMessage4`, node.path, e));
            newPathOK = false;
          }
        }
      } while (newPath && !newPathOK)
    }),

    vscode.commands.registerCommand(`code-for-ibmi.deleteObject`, async (node: ObjectBrowserObjectItem) => {
      let result = await vscode.window.showWarningMessage(t(`objectBrowser.deleteObject.warningMessage`, node.path, node.object.type.toUpperCase()), t(`Yes`), t(`Cancel`));

      if (result === t(`Yes`)) {
        const connection = getConnection();
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t("objectBrowser.deleteObject.progress", node.path, node.object.type.toUpperCase()) }
          , async (progress) => {
            try {
              // TODO: Progress message about deleting!
              await connection.remoteCommand(
                `DLTOBJ OBJ(${node.path}) OBJTYPE(${node.object.type})`,
              );

              vscode.window.showInformationMessage(t(`objectBrowser.deleteObject.infoMessage`, node.path, node.object.type.toUpperCase()));
              objectBrowser.refresh(node.parent);
            } catch (e) {
              vscode.window.showErrorMessage(t(`objectBrowser.deleteObject.errorMessage`, e));
            }
          }
        );
      }
    }),

    vscode.commands.registerCommand(`code-for-ibmi.renameObject`, async (node: ObjectBrowserObjectItem) => {
      let [, newObject] = node.path.split(`/`);
      let newObjectOK;
      do {
        newObject = await vscode.window.showInputBox({
          prompt: t(`objectBrowser.renameObject.prompt`),
          value: newObject,
          validateInput: newObject => {
            return newObject.length <= 10 ? null : t(`objectBrowser.renameObject.errorMessage`);
          }
        }) || "";

        if (newObject) {
          const escapedObject = newObject.replace(/'/g, `''`).replace(/`/g, `\\\``).split(`/`);
          const connection = getConnection();
          newObjectOK = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t("objectBrowser.renameObject.progress", node.path, node.object.type.toUpperCase(), escapedObject) }
            , async (progress) => {
              try {
                await connection.remoteCommand(
                  `RNMOBJ OBJ(${node.path}) OBJTYPE(${node.object.type}) NEWOBJ(${escapedObject})`
                );

                vscode.window.showInformationMessage(t(`objectBrowser.renameObject.infoMessage`, node.path, node.object.type.toUpperCase(), escapedObject));
                objectBrowser.refresh(node.parent);
                return true;
              } catch (e) {
                vscode.window.showErrorMessage(t(`objectBrowser.renameObject.errorMessage2`, node.path, e));
                return false;
              }
            }
          );
        }
      } while (newObject && !newObjectOK)
    }),

    vscode.commands.registerCommand(`code-for-ibmi.moveObject`, async (node: ObjectBrowserObjectItem) => {
      let [newLibrary,] = node.path.split(`/`);
      let newLibraryOK;
      do {
        newLibrary = await vscode.window.showInputBox({
          prompt: t(`objectBrowser.moveObject.prompt`),
          value: newLibrary,
          validateInput: newLibrary => {
            return newLibrary.length <= 10 ? null : t(`objectBrowser.moveObject.errorMessage`);

          }
        }) || "";

        if (newLibrary) {
          const escapedLibrary = newLibrary.replace(/'/g, `''`).replace(/`/g, `\\\``);
          const connection = getConnection();

          newLibraryOK = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t("objectBrowser.moveObject.progress", node.path, node.object.type.toUpperCase(), escapedLibrary) }
            , async (progress) => {
              try {
                await connection.remoteCommand(
                  `MOVOBJ OBJ(${node.path}) OBJTYPE(${node.object.type}) TOLIB(${newLibrary})`
                );

                if (!objectBrowser.autoRefresh(t(`objectBrowser.moveObject.infoMessage`, node.path, node.object.type.toUpperCase(), escapedLibrary))) {
                  vscode.window.showInformationMessage(t(`objectBrowser.moveObject.infoMessage2`, node.path, node.object.type.toUpperCase(), escapedLibrary));
                }
                return true;
              } catch (e) {
                vscode.window.showErrorMessage(t(`objectBrowser.moveObject.errorMessage2`, node.path, e));
                return false;
              }
            });
        }
      } while (newLibrary && !newLibraryOK)
    })
  );
}

function getConfig() {
  const config = instance.getConfig();
  if (config) {
    return config;
  }
  else {
    throw new Error(t('not.connected'));
  }
}

function getConnection() {
  const connection = instance.getConnection();
  if (connection) {
    return connection;
  }
  else {
    throw new Error(t('not.connected'));
  }
}

function getContent() {
  const content = instance.getContent();
  if (content) {
    return content;
  }
  else {
    throw new Error(t('not.connected'));
  }
}

function storeMemberList(path: string, list: string[]) {
  const storage = instance.getStorage();
  if (storage) {
    const existingDirs = storage.getSourceList();
    existingDirs[path] = list;
    return storage.setSourceList(existingDirs);
  }
}

async function doSearchInSourceFile(searchTerm: string, path: string, filter: ConnectionConfiguration.ObjectFilters | undefined) {
  const content = getContent();
  const pathParts = path.split(`/`);
  try {
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: t(`objectBrowser.doSearchInSourceFile.title`),
    }, async progress => {
      progress.report({
        message: t(`objectBrowser.doSearchInSourceFile.progressMessage`, path)
      });

      const members = await content.getMemberList(pathParts[0], pathParts[1], filter?.member);

      if (members.length > 0) {
        // NOTE: if more messages are added, lower the timeout interval
        const timeoutInternal = 9000;
        const searchMessages = [
          t(`objectBrowser.doSearchInSourceFile.searchMessage1`, searchTerm, path),
          t(`objectBrowser.doSearchInSourceFile.searchMessage2`, members.length, searchTerm, path),
          t(`objectBrowser.doSearchInSourceFile.searchMessage3`, searchTerm),
          t(`objectBrowser.doSearchInSourceFile.searchMessage4`, searchTerm, path),
          t(`objectBrowser.doSearchInSourceFile.searchMessage5`),
          t(`objectBrowser.doSearchInSourceFile.searchMessage6`),
          t(`objectBrowser.doSearchInSourceFile.searchMessage7`),
          t(`objectBrowser.doSearchInSourceFile.searchMessage8`, members.length),
          t(`objectBrowser.doSearchInSourceFile.searchMessage9`, searchTerm, path),
        ];

        let currentMessage = 0;
        const messageTimeout = setInterval(() => {
          if (currentMessage < searchMessages.length) {
            progress.report({
              message: searchMessages[currentMessage]
            });
            currentMessage++;
          } else {
            clearInterval(messageTimeout);
          }
        }, timeoutInternal);

        let results = await Search.searchMembers(instance, pathParts[0], pathParts[1], `${filter?.member || `*`}.MBR`, searchTerm, filter?.protected);

        // Filter search result by member type filter.
        if (results.length > 0 && filter?.member) {
          const patternExt = new RegExp(`^` + filter?.member.replace(/[*]/g, `.*`).replace(/[$]/g, `\\$`) + `$`);
          results = results.filter(result => {
            const resultPath = result.path.split(`/`);
            const resultName = resultPath[resultPath.length - 1];
            const member = members.find(member => member.name === resultName);
            return (member && patternExt.test(member.extension));
          })
        }

        if (results.length > 0) {
          const objectNamesLower = GlobalConfiguration.get(`ObjectBrowser.showNamesInLowercase`);

          // Format result to include member type.
          results.forEach(result => {
            const resultPath = result.path.split(`/`);
            const resultName = resultPath[resultPath.length - 1];
            result.path += `.${members.find(member => member.name === resultName)?.extension || ''}`;
            if (objectNamesLower === true) {
              result.path = result.path.toLowerCase();
            }
          });

          results = results.sort((a, b) => {
            return a.path.localeCompare(b.path);
          });

          setSearchResults(searchTerm, results);

        } else {
          vscode.window.showInformationMessage(t(`objectBrowser.doSearchInSourceFile.notFound`, searchTerm, path));
        }

      } else {
        vscode.window.showErrorMessage(t(`objectBrowser.doSearchInSourceFile.noMembers`));
      }

    });

  } catch (e) {
    vscode.window.showErrorMessage(t(`objectBrowser.doSearchInSourceFile.errorMessage`, e));
  }
}