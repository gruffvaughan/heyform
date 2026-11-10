import { Injectable } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model } from 'mongoose'

import { helper } from '@heyform-inc/utils'
import { ProjectMemberModel, ProjectModel, TeamModel } from '@model'

// createTeam inserts the workspace and its first project a few writes apart, in one request. Making
// another project by hand (open the dialog, type a name, submit) takes longer than this.
const CREATED_WITH_TEAM_MS = 2 * 1000

@Injectable()
export class ProjectService {
  constructor(
    @InjectModel(ProjectModel.name)
    private readonly projectModel: Model<ProjectModel>,
    @InjectModel(ProjectMemberModel.name)
    private readonly projectMemberModel: Model<ProjectMemberModel>
  ) {}

  async findAllInTeam(teamId: string): Promise<ProjectModel[]> {
    return this.projectModel
      .find({
        teamId
      })
      .sort({
        createdAt: -1
      })
  }

  // The project a member who joins the workspace lands in: the one it was created with. Once that
  // is deleted there is no default, rather than whichever project is now the oldest, which may be
  // one the owner keeps to a few members.
  async findDefaultInTeam(team: TeamModel): Promise<ProjectModel | null> {
    const project = await this.projectModel.findOne({
      teamId: team.id,
      isDefault: true
    })

    if (project || !team.createdAt) {
      return project
    }

    // A workspace from before isDefault: its first project, if it's still there, is the oldest one
    // without the field and was created with the team
    return this.projectModel
      .findOne({
        teamId: team.id,
        isDefault: {
          $exists: false
        },
        createdAt: {
          $lte: new Date(new Date(team.createdAt).getTime() + CREATED_WITH_TEAM_MS)
        }
      })
      .sort({
        createdAt: 1
      })
  }

  // A member of the workspace who belongs to no project can see none of its forms, so a joiner
  // starts in the project the workspace was created with. Removing or leaving the workspace
  // already deletes the project memberships.
  async addMemberToDefaultProject(team: TeamModel, memberId: string): Promise<void> {
    const project = await this.findDefaultInTeam(team)

    // A project can already name this member before they join the workspace
    if (project && !(await this.findMemberById(project.id, memberId))) {
      await this.createMember({
        projectId: project.id,
        memberId
      })
    }
  }

  async findOne(conditions: any) {
    return this.projectModel.findOne(conditions)
  }

  async findById(id: string): Promise<ProjectModel | null> {
    return this.projectModel.findById(id)
  }

  async findByIds(ids: string[], conditions?: Record<string, any>): Promise<ProjectModel[]> {
    return this.projectModel
      .find({
        _id: {
          $in: ids
        },
        ...conditions
      })
      .sort({
        createdAt: -1
      })
  }

  public async create(project: ProjectModel | any): Promise<string> {
    const result = await this.projectModel.create(project)
    return result.id
  }

  public async update(id: string, updates: Record<string, any>): Promise<boolean> {
    const result = await this.projectModel.updateOne(
      {
        _id: id
      },
      updates
    )
    return result.acknowledged
  }

  public async delete(id: string): Promise<boolean> {
    const result = await this.projectModel.deleteOne({
      _id: id
    })
    return (result.deletedCount ?? 0) > 0
  }

  public async findMemberById(
    projectId: string,
    memberId: string
  ): Promise<ProjectMemberModel | null> {
    return this.projectMemberModel.findOne({
      projectId,
      memberId
    })
  }

  public async findProjectByMemberId(memberId: string, projectId: string) {
    return this.projectMemberModel.findOne({
      memberId,
      projectId
    })
  }

  public async findProjectsByMemberId(memberId: string): Promise<string[]> {
    const members = await this.projectMemberModel.find({
      memberId
    })
    return members.map(row => row.projectId)
  }

  public async findMembers(projectId: string | string[]): Promise<ProjectMemberModel[]> {
    return this.projectMemberModel.find({
      projectId: helper.isArray(projectId) ? { $in: projectId } : projectId
    })
  }

  public async memberCount(projectId: string): Promise<number> {
    return this.projectMemberModel.countDocuments({
      projectId
    })
  }

  public async addMembers(members: any): Promise<any> {
    return this.projectMemberModel.insertMany(members, {
      ordered: false
    })
  }

  public async createMember(member: ProjectMemberModel | any): Promise<boolean> {
    const result = await this.projectMemberModel.create(member)
    return !!result.id
  }

  public async deleteMember(projectId: string, memberId: string): Promise<boolean> {
    const result = await this.projectMemberModel.deleteOne({
      projectId,
      memberId
    })
    return (result.deletedCount ?? 0) > 0
  }

  public async deleteMembers(projectId: string, memberIds: string[]): Promise<boolean> {
    const result = await this.projectMemberModel.deleteMany({
      projectId,
      memberId: {
        $in: memberIds
      }
    })
    return (result.deletedCount ?? 0) > 0
  }

  public async deleteMemberInProjects(projectIds: string[], memberId: string): Promise<boolean> {
    const result = await this.projectMemberModel.deleteMany({
      projectId: {
        $in: projectIds
      },
      memberId
    })
    return (result.deletedCount ?? 0) > 0
  }

  public async deleteAllMemberInProject(projectId: string): Promise<boolean> {
    const result = await this.projectMemberModel.deleteMany({
      projectId
    })
    return (result.deletedCount ?? 0) > 0
  }

  async createByNewTeam(teamId: string, ownerId: string, projectName: string): Promise<void> {
    const projectId = await this.create({
      teamId,
      name: projectName,
      ownerId,
      isDefault: true
    })

    await this.createMember({
      projectId,
      memberId: ownerId
    })
  }
}
